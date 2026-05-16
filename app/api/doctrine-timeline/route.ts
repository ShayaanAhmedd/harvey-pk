// app/api/doctrine-timeline/route.ts
//
// POST /api/doctrine-timeline
//
// Returns a chronological timeline of court decisions for a specific
// statutory provision, sourced from the legal_cases table.
//
// Request body:
//   { "act_name": "Pakistan Penal Code", "section_number": "302" }
//
// Response (200):
//   { "timeline": TimelineEntry[] }
//
// Deduplication: cases with identical (case_title, decision_year, outcome)
// are collapsed — keeps the first occurrence after sorting.
// Max 20 entries returned.
//
// Auth: authenticated users only.

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";

// ── Types ─────────────────────────────────────────────────────────────────────

interface TimelineEntry {
  decision_year:  number | null;
  case_title:     string | null;
  authority_tier: string | null;
  outcome:        string | null;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const MAX_ENTRIES = 20;

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

  // ── 3. Query legal_cases ──────────────────────────────────────────────────
  // Fetch more than MAX_ENTRIES to have room to deduplicate before truncating.
  const { data, error } = await supabase
    .from("legal_cases")
    .select("case_title, authority_tier, decision_year, outcome")
    .eq("act_name",       act_name)
    .eq("section_number", section_number)
    .order("decision_year", { ascending: true, nullsFirst: false })
    .limit(MAX_ENTRIES * 3);

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }

  if (!data || data.length === 0) {
    return NextResponse.json({ timeline: [] });
  }

  // ── 4. Deduplicate ────────────────────────────────────────────────────────
  // Two rows are considered duplicates when they share the same
  // (case_title, decision_year, outcome) triple.
  // The query is already sorted by decision_year, so the first occurrence
  // of each key is the one we keep.
  const seen   = new Set<string>();
  const unique: TimelineEntry[] = [];

  for (const row of data as TimelineEntry[]) {
    const key = `${row.case_title ?? ""}|${row.decision_year ?? ""}|${row.outcome ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push({
      decision_year:  row.decision_year  ?? null,
      case_title:     row.case_title     ?? null,
      authority_tier: row.authority_tier ?? null,
      outcome:        row.outcome        ?? null,
    });
    if (unique.length === MAX_ENTRIES) break;
  }

  // ── 5. Return ─────────────────────────────────────────────────────────────
  return NextResponse.json({ timeline: unique });
}
