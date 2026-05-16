// lib/ai/legal-graph.ts
//
// Legal Knowledge Graph Query Module.
// Provides structured graph queries over legal_entities + legal_relationships.
//
// Safety:
//   - Max 3 DB queries per function
//   - Graceful null/empty returns on failures
//   - Deterministic — no LLM calls, no side effects

// eslint-disable-next-line @typescript-eslint/no-explicit-any
import type { SupabaseClient } from "@supabase/supabase-js";

// ── Public types ──────────────────────────────────────────────────────────────

export interface CaseGraphResult {
  related_cases:      { name: string; relationship_type: string }[];
  interpreting_cases: { name: string }[];
  overruling_cases:   { name: string }[];
  cited_cases:        { name: string }[];
  judges:             { name: string }[];
  courts:             { name: string }[];
}

export interface SectionDoctrineResult {
  leading_cases:         { name: string; weight: number }[];
  supporting_precedents: { name: string }[];
  negative_treatments:   { name: string }[];
  stability_score:       number;
}

// ── Knowledge graph insight (used by IRAC) ────────────────────────────────────

export interface KnowledgeGraphInsight {
  related_cases:         number;
  citing_cases:          number;
  overruling_cases:      number;
  doctrine_cluster_size: number;
}

// ── Internal row types ────────────────────────────────────────────────────────

type EntityRow = {
  id:          string;
  entity_type: string;
  name:        string;
};

type RelRow = {
  from_entity:       string;
  to_entity:         string;
  relationship_type: string;
  weight:            number;
};

type LegalCaseRow = {
  id:             string;
  outcome:        string | null;
  authority_tier: string | null;
};

// ── getCaseGraph ──────────────────────────────────────────────────────────────
// 2 queries: relationships + entity details.
// caseId must equal the legal_entities.id for the case entity.

export async function getCaseGraph(
  caseId:   string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any>,
): Promise<CaseGraphResult> {
  const empty: CaseGraphResult = {
    related_cases: [], interpreting_cases: [], overruling_cases: [],
    cited_cases: [], judges: [], courts: [],
  };

  try {
    // Q1: all relationships where this case is the source or target
    const { data: relData, error: relErr } = await supabase
      .from("legal_relationships")
      .select("from_entity, to_entity, relationship_type, weight")
      .or(`from_entity.eq.${caseId},to_entity.eq.${caseId}`);

    if (relErr || !relData || relData.length === 0) return empty;
    const rels = relData as RelRow[];

    // Collect all unique referenced entity IDs (excluding the case itself)
    const entityIds = [
      ...new Set(
        rels.flatMap((r) => [r.from_entity, r.to_entity]).filter((id) => id !== caseId)
      ),
    ];
    if (entityIds.length === 0) return empty;

    // Q2: entity details for all referenced IDs
    const { data: entityData } = await supabase
      .from("legal_entities")
      .select("id, entity_type, name")
      .in("id", entityIds);

    const entityMap = new Map<string, EntityRow>();
    for (const e of ((entityData ?? []) as EntityRow[])) {
      entityMap.set(e.id, e);
    }

    const result: CaseGraphResult = {
      related_cases: [], interpreting_cases: [], overruling_cases: [],
      cited_cases: [], judges: [], courts: [],
    };

    for (const rel of rels) {
      const peerId  = rel.from_entity === caseId ? rel.to_entity : rel.from_entity;
      const peer    = entityMap.get(peerId);
      if (!peer) continue;

      const rtype = rel.relationship_type;

      if (peer.entity_type === "case") {
        result.related_cases.push({ name: peer.name, relationship_type: rtype });
        if (rtype === "interprets")  result.interpreting_cases.push({ name: peer.name });
        if (rtype === "overrules")   result.overruling_cases.push({ name: peer.name });
        if (rtype === "cites")       result.cited_cases.push({ name: peer.name });
      } else if (peer.entity_type === "judge") {
        result.judges.push({ name: peer.name });
      } else if (peer.entity_type === "court") {
        result.courts.push({ name: peer.name });
      }
    }

    return result;
  } catch {
    return empty;
  }
}

// ── getSectionDoctrine ────────────────────────────────────────────────────────
// 3 queries: section entity lookup → interpreting relationships → case outcomes.

export async function getSectionDoctrine(
  actName:       string,
  sectionNumber: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:      SupabaseClient<any>,
): Promise<SectionDoctrineResult | null> {
  try {
    // Q1: find section entity
    const compoundName = `${actName}:::${sectionNumber}`;
    const { data: entityData, error: entityErr } = await supabase
      .from("legal_entities")
      .select("id")
      .eq("entity_type", "section")
      .eq("name", compoundName)
      .maybeSingle();

    if (entityErr || !entityData) return null;
    const sectionEntityId = (entityData as { id: string }).id;

    // Q2: relationships where this section is target (cases interpreting it)
    //     or source (section→act contains relationships are excluded by entity_type filter below)
    const { data: relData } = await supabase
      .from("legal_relationships")
      .select("from_entity, relationship_type, weight")
      .eq("to_entity", sectionEntityId)
      .eq("relationship_type", "interprets");

    if (!relData || relData.length === 0) {
      return { leading_cases: [], supporting_precedents: [], negative_treatments: [], stability_score: 1.0 };
    }

    const interpretingCaseIds = (relData as RelRow[]).map((r) => r.from_entity);
    const weightMap = new Map<string, number>(
      (relData as RelRow[]).map((r) => [r.from_entity, r.weight])
    );

    // Q3: case details from legal_cases to derive outcome + authority tier
    const { data: caseData } = await supabase
      .from("legal_cases")
      .select("id, outcome, authority_tier")
      .in("id", interpretingCaseIds);

    const caseRows = (caseData ?? []) as LegalCaseRow[];

    // Also fetch case names from legal_entities
    const { data: nameData } = await supabase
      .from("legal_entities")
      .select("id, name")
      .in("id", interpretingCaseIds)
      .eq("entity_type", "case");

    const nameMap = new Map<string, string>(
      ((nameData ?? []) as EntityRow[]).map((e) => [e.id, e.name])
    );

    const leading_cases:         { name: string; weight: number }[] = [];
    const supporting_precedents: { name: string }[] = [];
    const negative_treatments:   { name: string }[] = [];

    for (const c of caseRows) {
      const name   = nameMap.get(c.id) ?? c.id.slice(0, 8);
      const weight = weightMap.get(c.id) ?? 1.0;

      if (c.authority_tier === "supreme") {
        leading_cases.push({ name, weight });
      }
      if (c.outcome === "favorable") {
        supporting_precedents.push({ name });
      } else if (c.outcome === "unfavorable" || c.outcome === "mixed") {
        negative_treatments.push({ name });
      }
    }

    const total  = supporting_precedents.length + negative_treatments.length;
    const stability_score =
      total > 0
        ? Math.round((supporting_precedents.length / total) * 1000) / 1000
        : 1.0;

    // Sort leading_cases by weight desc
    leading_cases.sort((a, b) => b.weight - a.weight);

    return { leading_cases, supporting_precedents, negative_treatments, stability_score };
  } catch {
    return null;
  }
}

// ── queryKnowledgeGraphInsight ────────────────────────────────────────────────
// Used by IRAC pipeline: 2 queries max.
// Accepts section compound names (act:::section) to batch-lookup entities + rels.

export async function queryKnowledgeGraphInsight(
  citationSectionNames: string[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase:             SupabaseClient<any>,
): Promise<KnowledgeGraphInsight | null> {
  if (citationSectionNames.length === 0) return null;

  try {
    // Q1: find entity IDs for all cited sections
    const { data: entityData } = await supabase
      .from("legal_entities")
      .select("id")
      .eq("entity_type", "section")
      .in("name", citationSectionNames);

    if (!entityData || entityData.length === 0) return null;

    const sectionEntityIds = (entityData as { id: string }[]).map((e) => e.id);

    // Q2: all relationships touching these section entities
    const { data: relData } = await supabase
      .from("legal_relationships")
      .select("from_entity, to_entity, relationship_type")
      .or(
        `from_entity.in.(${sectionEntityIds.join(",")}),to_entity.in.(${sectionEntityIds.join(",")})`,
      );

    if (!relData || relData.length === 0) return null;

    const rels = relData as Pick<RelRow, "from_entity" | "to_entity" | "relationship_type">[];

    const related_cases    = rels.filter((r) => r.relationship_type === "interprets").length;
    const citing_cases     = related_cases; // interprets = cases citing this section
    const overruling_cases = rels.filter((r) => r.relationship_type === "overrules").length;
    const doctrine_cluster_size = new Set([
      ...rels.map((r) => r.from_entity),
      ...rels.map((r) => r.to_entity),
    ]).size;

    return { related_cases, citing_cases, overruling_cases, doctrine_cluster_size };
  } catch {
    return null;
  }
}
