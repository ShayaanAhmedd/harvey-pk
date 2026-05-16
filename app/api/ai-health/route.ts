// app/api/ai-health/route.ts
//
// Admin-only LLM infrastructure health check.
//
// GET /api/ai-health
//
// Sends the same deterministic probe to every configured AI provider in
// parallel and returns a structured health report.
//
// Response shape:
//   200 {
//     timestamp:  ISO8601,
//     timestamp, summary: { total_providers, healthy, degraded, down },
//     providers: [ { provider, model, runs, latency_ms, json_valid,
//                    reasoning_correct, token_correct, checksum_correct,
//                    status, error_type, raw_truncated } ],
//     routing: { primary_provider, secondary_provider, blocked_providers, reasoning }
//   }
//   401 { success: false, error: "Unauthorized" }
//   403 { success: false, error: "Forbidden" }

export const runtime = "nodejs";

import { NextResponse }       from "next/server";
import { createClient }       from "@/lib/supabase/server";
import { runLLMHealthCheck }  from "@/lib/ai/healthcheck";

export async function GET() {
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();

  if (!user) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const { data: roleRow } = await supabase
    .from("user_roles")
    .select("role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (roleRow?.role !== "admin") {
    return NextResponse.json({ success: false, error: "Forbidden" }, { status: 403 });
  }

  const report = await runLLMHealthCheck();

  return NextResponse.json(report);
}
