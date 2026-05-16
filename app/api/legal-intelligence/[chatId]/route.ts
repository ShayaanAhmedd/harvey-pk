// app/api/legal-intelligence/[chatId]/route.ts
//
// GET /api/legal-intelligence/[chatId]
//
// Returns aggregated legal intelligence from the most recent premium (IRAC)
// message in the specified chat — without recomputing the IRAC pipeline.
//
// Strategy:
//   1. Authenticate the requesting user.
//   2. Verify chat ownership via RLS (SELECT returns null if user doesn't own it).
//   3. Fetch the last 10 assistant messages ordered newest-first.
//   4. Walk back through them, attempt JSON.parse, identify the first message
//      that contains a valid IracResponse (detected via `confidence_score`).
//   5. Extract and return the 9 dashboard fields + summary metadata.
//
// Response shapes:
//   200 { has_intelligence: true,  message_id, created_at, meta, ...fields }
//   200 { has_intelligence: false, reason }   — chat exists but no IRAC message yet
//   401 { error: "Unauthorized" }
//   404 { error: "Chat not found" }
//   500 { error: string }

export const runtime = "nodejs";

import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import type { IracResponse } from "@/lib/ai/irac";
import { extractJson } from "@/lib/ai/extract-json";

// ── Type helpers ──────────────────────────────────────────────────────────────

type Params = { params: Promise<{ chatId: string }> };

/**
 * Fields projected out of IracResponse for the dashboard.
 * Each is optional — the upstream pipeline produces them incrementally.
 */
interface IntelligencePayload {
  has_intelligence:     true;
  message_id:           string;
  created_at:           string;
  /** Concise metadata for quick-glance display tiles */
  meta: {
    confidence_score: number;
    risk_level:       "low" | "moderate" | "high";
    issue_summary:    string;  // first 220 chars of irac.issue
  };
  litigation_brief?:        IracResponse["litigation_brief"];
  litigation_assessment?:   IracResponse["litigation_assessment"];
  doctrine_analysis?:       IracResponse["doctrine_analysis"];
  doctrine_influence?:      IracResponse["doctrine_influence"];
  precedent_intelligence?:  IracResponse["precedent_intelligence"];
  forum_intelligence?:      IracResponse["forum_intelligence"];
  benchmark_assessment?:    IracResponse["benchmark_assessment"];
  strategy_simulation?:     IracResponse["strategy_simulation"];
  knowledge_graph_insight?: IracResponse["knowledge_graph_insight"];
}

interface NoIntelligencePayload {
  has_intelligence: false;
  reason:           string;
}

// ── IracResponse detection ────────────────────────────────────────────────────
//
// A message is an IRAC message when its content JSON-parses to an object that
// has `confidence_score` (number) + `risk_level` (string) + `citations` (array).
// This avoids false positives on plain-text assistant messages.

function parseIracContent(content: string): IracResponse | null {
  try {
    const parsed = JSON.parse(extractJson(content)) as Record<string, unknown>;

    if (
      typeof parsed.confidence_score !== "number"  ||
      typeof parsed.risk_level       !== "string"  ||
      typeof parsed.issue            !== "string"  ||
      !Array.isArray(parsed.citations)
    ) {
      return null;
    }

    return parsed as unknown as IracResponse;
  } catch {
    return null;
  }
}

// ── Dashboard projection ──────────────────────────────────────────────────────
//
// Extracts only the fields requested by the dashboard.
// `undefined` optional fields are omitted from the JSON response by Next.js
// serialisation automatically.

function projectIntelligence(
  irac:       IracResponse,
  messageId:  string,
  createdAt:  string,
): IntelligencePayload {
  return {
    has_intelligence:    true,
    message_id:          messageId,
    created_at:          createdAt,
    meta: {
      confidence_score: irac.confidence_score,
      risk_level:       irac.risk_level,
      issue_summary:    irac.issue.slice(0, 220).trimEnd(),
    },
    // Optional intelligence fields — only included when the pipeline produced them
    ...(irac.litigation_brief        && { litigation_brief:        irac.litigation_brief }),
    ...(irac.litigation_assessment   && { litigation_assessment:   irac.litigation_assessment }),
    ...(irac.doctrine_analysis       && { doctrine_analysis:       irac.doctrine_analysis }),
    ...(irac.doctrine_influence      && { doctrine_influence:      irac.doctrine_influence }),
    ...(irac.precedent_intelligence  && { precedent_intelligence:  irac.precedent_intelligence }),
    ...(irac.forum_intelligence      && { forum_intelligence:      irac.forum_intelligence }),
    ...(irac.benchmark_assessment    && { benchmark_assessment:    irac.benchmark_assessment }),
    ...(irac.strategy_simulation     && { strategy_simulation:     irac.strategy_simulation }),
    ...(irac.knowledge_graph_insight && { knowledge_graph_insight: irac.knowledge_graph_insight }),
  };
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function GET(_req: Request, { params }: Params) {
  const { chatId } = await params;

  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // ── 1. Verify chat exists and belongs to this user (RLS) ─────────────────
  const { data: chat, error: chatError } = await supabase
    .from("chats")
    .select("id")
    .eq("id", chatId)
    .maybeSingle();

  if (chatError) {
    return NextResponse.json({ error: chatError.message }, { status: 500 });
  }
  if (!chat) {
    return NextResponse.json({ error: "Chat not found" }, { status: 404 });
  }

  // ── 2. Fetch recent assistant messages (newest-first) ────────────────────
  // Limit 10 — walks back to find the most recent IRAC-mode message.
  // Plain-text messages from fast/deep/web modes are skipped automatically.
  const { data: messages, error: msgError } = await supabase
    .from("messages")
    .select("id, content, created_at")
    .eq("chat_id", chatId)
    .eq("role", "assistant")
    .order("created_at", { ascending: false })
    .limit(10);

  if (msgError) {
    return NextResponse.json({ error: msgError.message }, { status: 500 });
  }

  if (!messages || messages.length === 0) {
    const payload: NoIntelligencePayload = {
      has_intelligence: false,
      reason:           "No assistant messages found in this chat.",
    };
    return NextResponse.json(payload);
  }

  // ── 3. Find the most recent IRAC-mode message ────────────────────────────
  for (const msg of messages) {
    const irac = parseIracContent(msg.content ?? "");
    if (!irac) continue;  // plain-text message — skip

    const payload = projectIntelligence(irac, msg.id, msg.created_at);
    return NextResponse.json(payload);
  }

  // ── 4. No IRAC message found in the scanned window ──────────────────────
  const noIntelligence: NoIntelligencePayload = {
    has_intelligence: false,
    reason:           "No premium (IRAC) analysis found in the most recent messages. Switch to Premium mode and ask a legal question to generate intelligence.",
  };
  return NextResponse.json(noIntelligence);
}
