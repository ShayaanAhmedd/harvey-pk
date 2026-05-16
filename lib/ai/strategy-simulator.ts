// lib/ai/strategy-simulator.ts
//
// Strategy Simulation Engine — pure deterministic math, no LLM, no DB queries.
// Generates 4 litigation strategies with adjusted success probabilities.

// ── Types ─────────────────────────────────────────────────────────────────────

export type StrategyRiskLevel = "low" | "moderate" | "high";

export interface SimulatedStrategy {
  strategy_type:                 string;
  description:                   string;
  adjusted_success_probability:  number;
  adjusted_risk_level:           StrategyRiskLevel;
  reasoning_factors:             string[];
}

export interface StrategySimulationParams {
  baseProbability:      number;           // litigation_assessment.success_probability
  riskLevel:            StrategyRiskLevel;
  precedentStrength:    number;           // precedent_intelligence.precedent_strength_score (0 if absent)
  doctrineInstability:  boolean;          // precedent_intelligence.doctrine_instability
  judgeStrictness:      number;           // forum_intelligence.judge_strictness_index (0 if absent)
  forumSuccessRate:     number;           // forum_intelligence.forum_success_rate (0 if absent)
  benchmarkSuccessRate: number;           // benchmark_assessment.historical_success_rate (0.5 if absent)
}

export interface StrategySimulationResult {
  strategies: SimulatedStrategy[];
}

// ── Risk level from probability ───────────────────────────────────────────────

function probabilityToStrategyRisk(p: number): StrategyRiskLevel {
  if (p >= 0.7) return "low";
  if (p >= 0.5) return "moderate";
  return "high";
}

function clamp(v: number): number {
  return Math.min(1, Math.max(0, v));
}

function round3(v: number): number {
  return Math.round(v * 1000) / 1000;
}

// ── Individual strategy calculators ──────────────────────────────────────────

function bindingPrecedentStrategy(params: StrategySimulationParams): SimulatedStrategy {
  let adj   = params.baseProbability;
  const factors: string[] = ["Relies on binding Supreme Court authority."];

  if (params.precedentStrength > 1) {
    adj += 0.05;
    factors.push(`Strong precedent network (score ${params.precedentStrength.toFixed(2)}) supports claim.`);
  }
  if (params.doctrineInstability) {
    adj -= 0.05;
    factors.push("Doctrine instability detected — overruling risk reduces reliability.");
  }

  const p = round3(clamp(adj));
  return {
    strategy_type:                "binding_precedent_strategy",
    description:                  "Anchor arguments exclusively to Supreme Court judgments and binding precedent chains.",
    adjusted_success_probability:  p,
    adjusted_risk_level:           probabilityToStrategyRisk(p),
    reasoning_factors:             factors,
  };
}

function expansiveInterpretationStrategy(params: StrategySimulationParams): SimulatedStrategy {
  let adj   = params.baseProbability;
  const factors: string[] = ["Draws on High Court precedent and statutory construction arguments."];

  if (params.forumSuccessRate > params.benchmarkSuccessRate) {
    adj += 0.04;
    factors.push(
      `Forum success rate (${(params.forumSuccessRate * 100).toFixed(1)}%) ` +
      `exceeds national benchmark (${(params.benchmarkSuccessRate * 100).toFixed(1)}%).`,
    );
  }
  if (params.judgeStrictness > 0.6) {
    adj -= 0.03;
    factors.push(`Judge strictness index ${params.judgeStrictness.toFixed(2)} may limit interpretive latitude.`);
  }

  const p = round3(clamp(adj));
  return {
    strategy_type:                "expansive_interpretation_strategy",
    description:                  "Leverage High Court decisions and broad statutory interpretation to widen the legal argument.",
    adjusted_success_probability:  p,
    adjusted_risk_level:           probabilityToStrategyRisk(p),
    reasoning_factors:             factors,
  };
}

function proceduralAttackStrategy(params: StrategySimulationParams): SimulatedStrategy {
  let adj   = params.baseProbability;
  const factors: string[] = ["Targets procedural defects and evidentiary weaknesses in opposing case."];

  if (params.judgeStrictness > 0.6) {
    adj += 0.05;
    factors.push(
      `High judge strictness (${params.judgeStrictness.toFixed(2)}) ` +
      "suggests procedural rigor — procedural challenges are more likely to succeed.",
    );
  }
  if (params.precedentStrength > 1.5) {
    adj -= 0.02;
    factors.push("Strong opposing precedent base reduces procedural maneuverability.");
  }

  const p = round3(clamp(adj));
  return {
    strategy_type:                "procedural_attack_strategy",
    description:                  "Challenge opposing claims on procedural grounds: jurisdiction, standing, admissibility, or limitation.",
    adjusted_success_probability:  p,
    adjusted_risk_level:           probabilityToStrategyRisk(p),
    reasoning_factors:             factors,
  };
}

function settlementLeverageStrategy(params: StrategySimulationParams): SimulatedStrategy {
  const p = round3(clamp(params.baseProbability * 0.85));
  const factors: string[] = [
    "Negotiation posture — success probability discounted to reflect settlement dynamics.",
    "Avoids courtroom risk; outcome depends on counterparty willingness.",
  ];

  if (params.judgeStrictness > 0.6) {
    factors.push("High judge strictness increases incentive to settle before trial.");
  }
  if (params.doctrineInstability) {
    factors.push("Doctrine instability adds uncertainty — early settlement may reduce exposure.");
  }

  return {
    strategy_type:                "settlement_leverage_strategy",
    description:                  "Use litigation threat as leverage for favourable settlement without proceeding to trial.",
    adjusted_success_probability:  p,
    adjusted_risk_level:           probabilityToStrategyRisk(p),
    reasoning_factors:             factors,
  };
}

// ── Public entry point ────────────────────────────────────────────────────────

export function simulateStrategies(
  params: StrategySimulationParams,
): StrategySimulationResult {
  return {
    strategies: [
      bindingPrecedentStrategy(params),
      expansiveInterpretationStrategy(params),
      proceduralAttackStrategy(params),
      settlementLeverageStrategy(params),
    ],
  };
}
