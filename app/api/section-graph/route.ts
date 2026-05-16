// app/api/section-graph/route.ts
//
// POST /api/section-graph
//
// Returns the relationship graph for a single statutory provision,
// sourced from legal_entities + legal_relationships tables.
//
// Request body:
//   { "act_name": "Pakistan Penal Code", "section_number": "302" }
//
// Response (200):
//   {
//     "section": "Pakistan Penal Code §302",
//     "relationships": {
//       "interpreted_by_cases": RelationshipEntry[],
//       "cited_sections":       RelationshipEntry[],
//       "amendments":           RelationshipEntry[],
//       "related_sections":     RelationshipEntry[]
//     }
//   }
//
// Classification:
//   interpreted_by_cases — peer entity_type = 'case', relation IN ('interprets','cites','applied_by','follows','overrules','distinguishes')
//   cited_sections       — peer entity_type = 'section', relation IN ('cites','references','related_to','compared_with')
//   amendments           — any entity_type,              relation IN ('amended_by','amends','superseded_by','repealed_by','replaces')
//   related_sections     — peer entity_type = 'section', everything else
//
// Rules: max 50 relationships fetched, deduplicated by peer entity name.
//
// Auth: authenticated users only.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ── Types ─────────────────────────────────────────────────────────────────────

interface RelationshipEntry {
  name:              string;
  entity_type:       string;
  relationship_type: string;
  direction:         "outgoing" | "incoming";
  weight:            number;
}

interface RelationshipBuckets {
  interpreted_by_cases: RelationshipEntry[];
  cited_sections:       RelationshipEntry[];
  amendments:           RelationshipEntry[];
  related_sections:     RelationshipEntry[];
}

// ── Supabase row shapes ────────────────────────────────────────────────────────

interface EntityRow {
  id:          string;
  entity_type: string;
  name:        string;
}

interface RelRow {
  from_entity:       string;
  to_entity:         string;
  relationship_type: string;
  weight:            number;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_RELATIONSHIPS = 50;

const CASE_RELATIONS = new Set([
  "interprets", "cites", "applied_by", "follows", "overrules", "distinguishes",
]);

const CROSS_SECTION_RELATIONS = new Set([
  "cites", "references", "related_to", "compared_with",
]);

const AMENDMENT_RELATIONS = new Set([
  "amended_by", "amends", "superseded_by", "repealed_by", "replaces",
]);

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(req: Request) {
  // ── 1. Auth ───────────────────────────────────────────────────────────────
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 2. Parse + validate body ──────────────────────────────────────────────
  let act_name: string;
  let section_number: string;

  try {
    const body = await req.json() as Record<string, unknown>;

    if (typeof body.act_name !== "string" || body.act_name.trim().length === 0) {
      return NextResponse.json(
        { error: "act_name must be a non-empty string" },
        { status: 400 }
      );
    }
    if (typeof body.section_number !== "string" || body.section_number.trim().length === 0) {
      return NextResponse.json(
        { error: "section_number must be a non-empty string" },
        { status: 400 }
      );
    }

    act_name       = body.act_name.trim();
    section_number = body.section_number.trim();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  // ── 3. Look up section entity ─────────────────────────────────────────────
  // Section names are stored as compound key: {act_name}:::{section_number}
  const compoundKey = `${act_name}:::${section_number}`;

  const { data: entityData, error: entityError } = await supabase
    .from("legal_entities")
    .select("id, entity_type, name")
    .eq("entity_type", "section")
    .eq("name", compoundKey)
    .maybeSingle();

  if (entityError) {
    return NextResponse.json({ error: entityError.message }, { status: 500 });
  }

  if (!entityData) {
    // Section not in knowledge graph — return empty graph gracefully
    return NextResponse.json({
      section:       `${act_name} §${section_number}`,
      relationships: {
        interpreted_by_cases: [],
        cited_sections:       [],
        amendments:           [],
        related_sections:     [],
      },
    });
  }

  const sectionId = (entityData as EntityRow).id;

  // ── 4. Fetch relationships ────────────────────────────────────────────────
  const { data: relData, error: relError } = await supabase
    .from("legal_relationships")
    .select("from_entity, to_entity, relationship_type, weight")
    .or(`from_entity.eq.${sectionId},to_entity.eq.${sectionId}`)
    .limit(MAX_RELATIONSHIPS);

  if (relError) {
    return NextResponse.json({ error: relError.message }, { status: 500 });
  }

  const rels = (relData ?? []) as RelRow[];

  if (rels.length === 0) {
    return NextResponse.json({
      section:       `${act_name} §${section_number}`,
      relationships: {
        interpreted_by_cases: [],
        cited_sections:       [],
        amendments:           [],
        related_sections:     [],
      },
    });
  }

  // ── 5. Collect peer entity IDs ────────────────────────────────────────────
  const peerIds = Array.from(new Set(
    rels.map((r) => r.from_entity === sectionId ? r.to_entity : r.from_entity)
  ));

  const { data: peerData, error: peerError } = await supabase
    .from("legal_entities")
    .select("id, entity_type, name")
    .in("id", peerIds);

  if (peerError) {
    // Non-fatal: proceed without peer enrichment
    console.error("[section-graph] peer lookup failed:", peerError.message);
  }

  const peerMap = new Map<string, EntityRow>();
  for (const p of ((peerData ?? []) as EntityRow[])) {
    peerMap.set(p.id, p);
  }

  // ── 6. Build + classify entries ───────────────────────────────────────────
  const buckets: RelationshipBuckets = {
    interpreted_by_cases: [],
    cited_sections:       [],
    amendments:           [],
    related_sections:     [],
  };

  // Dedup by peer name to avoid duplicated entries from bidirectional edges
  const seen = new Set<string>();

  for (const rel of rels) {
    const peerId    = rel.from_entity === sectionId ? rel.to_entity : rel.from_entity;
    const direction = rel.from_entity === sectionId ? "outgoing" : "incoming";
    const peer      = peerMap.get(peerId);
    const peerName  = peer?.name ?? peerId;
    const peerType  = peer?.entity_type ?? "unknown";
    const relType   = rel.relationship_type;

    // Skip self-references
    if (peerId === sectionId) continue;

    const dedupKey = `${peerName}|${relType}`;
    if (seen.has(dedupKey)) continue;
    seen.add(dedupKey);

    const entry: RelationshipEntry = {
      name:              peerName,
      entity_type:       peerType,
      relationship_type: relType,
      direction,
      weight:            rel.weight ?? 1.0,
    };

    if (AMENDMENT_RELATIONS.has(relType)) {
      buckets.amendments.push(entry);
    } else if (peerType === "case" && CASE_RELATIONS.has(relType)) {
      buckets.interpreted_by_cases.push(entry);
    } else if (peerType === "section" && CROSS_SECTION_RELATIONS.has(relType)) {
      buckets.cited_sections.push(entry);
    } else if (peerType === "section") {
      buckets.related_sections.push(entry);
    } else if (peerType === "case") {
      // Case relationship with a type not in CASE_RELATIONS — still a case interpretation
      buckets.interpreted_by_cases.push(entry);
    }
    // act/court/judge entities fall through and are omitted (structural, not legally meaningful here)
  }

  // ── 7. Return ─────────────────────────────────────────────────────────────
  return NextResponse.json({
    section:       `${act_name} §${section_number}`,
    relationships: buckets,
  });
}
