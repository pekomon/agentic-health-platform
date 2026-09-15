import type { Evidence, RecommendationDraft } from "@ahp/health-domain";
import { connectHealthTools, createSyntheticHealthTools, type HealthToolName } from "@ahp/health-tools";

import { finalizeRecommendation, type RecommendationResult } from "../src/finalize.js";
import { EvidenceLedger, type DeliveredToolCall } from "../src/ledger.js";
import { evaluateScenario, type EvalReport } from "./assertions.js";
import { loadScenarioFixture, type ScenarioId } from "./scenarios.js";

function evidenceId(entry: Evidence): string {
  return entry.kind === "observation" ? entry.observation.id : entry.id;
}

function findEvidence(entries: readonly Evidence[], metric: string): string {
  const entry = entries.find((candidate) => candidate.kind === "observation" && candidate.observation.metric === metric);
  if (entry === undefined) throw new Error("MISSING_SCRIPTED_EVIDENCE");
  return evidenceId(entry);
}

function findMissing(entries: readonly Evidence[], metric: string): string {
  const entry = entries.find((candidate) => candidate.kind === "missing" && candidate.metric === metric);
  if (entry === undefined) throw new Error("MISSING_SCRIPTED_LIMITATION");
  return evidenceId(entry);
}

export function scriptedDraft(scenarioId: ScenarioId, evidence: readonly Evidence[]): RecommendationDraft {
  const profile = findEvidence(evidence, "profile.goal");
  const time = findEvidence(evidence, "context.available_minutes");
  const sleep = evidence.some((entry) => entry.kind === "observation" && entry.observation.metric === "sleep.duration") ? findEvidence(evidence, "sleep.duration") : null;
  const recovery = evidence.some((entry) => entry.kind === "observation" && entry.observation.metric === "oura.readiness_score") ? findEvidence(evidence, "oura.readiness_score") : null;
  const healthIds = [sleep, recovery].filter((id): id is string => id !== null);
  const limitations = [
    ...(sleep === null ? [findMissing(evidence, "sleep.duration")] : []),
    ...(recovery === null ? [findMissing(evidence, "oura.readiness_score")] : [])
  ];
  const choice = {
    well_recovered_runner: { activity: "RUNNING", intensity: "MODERATE", durationMinutes: 35, confidence: 0.82 },
    poor_sleep_low_recovery: { activity: "WALKING", intensity: "EASY", durationMinutes: 20, confidence: 0.66 },
    strength_goal_good_recovery: { activity: "STRENGTH", intensity: "MODERATE", durationMinutes: 40, confidence: 0.82 },
    late_evening_low_recovery: { activity: "MOBILITY", intensity: "EASY", durationMinutes: 10, confidence: 0.58 },
    missing_data: { activity: "WALKING", intensity: "EASY", durationMinutes: 15, confidence: 0.3 }
  } as const;
  const selected = choice[scenarioId];
  return {
    ...selected,
    targetHeartRateZone: null,
    rationaleClaims: [
      { text: "This recommendation follows the stated goal and available time.", evidenceIds: [profile, time] },
      { text: sleep === null || recovery === null ? "Sleep and recovery history are unavailable, so the recommendation is conservative." : "The recommendation considers the available sleep and recovery observations.", evidenceIds: healthIds.length > 0 ? healthIds : limitations }
    ],
    limitationIds: limitations
  };
}

async function deliveredCalls(scenarioId: ScenarioId): Promise<{ calls: DeliveredToolCall[]; ledger: EvidenceLedger }> {
  const connection = await connectHealthTools(createSyntheticHealthTools(loadScenarioFixture(scenarioId)));
  const ledger = new EvidenceLedger();
  const calls: DeliveredToolCall[] = [];
  const requested: readonly [HealthToolName, Record<string, unknown>][] = [
    ["get_user_profile", {}], ["get_current_context", {}], ["get_sleep_history", { days: 14 }], ["get_recovery_history", { days: 14 }], ["get_recent_training", { days: 14 }]
  ];
  try {
    for (const [name, input] of requested) {
      const result = await connection.callTool(name, input);
      const call = { name, result };
      const recorded = ledger.record(call);
      if (!recorded.ok) throw new Error(recorded.error.code);
      calls.push(call);
    }
    return { calls, ledger };
  } finally {
    await connection.close();
  }
}

export type ReplayResult = { draft: RecommendationDraft; finalResult: RecommendationResult; report: EvalReport; calls: DeliveredToolCall[] };

export async function replayScenario(scenarioId: ScenarioId, draftOverride?: unknown): Promise<ReplayResult> {
  const { calls, ledger } = await deliveredCalls(scenarioId);
  const draft = draftOverride ?? scriptedDraft(scenarioId, [...ledger.snapshot().evidence.values()]);
  const finalResult = finalizeRecommendation(draft, ledger.snapshot());
  return { draft: draft as RecommendationDraft, finalResult, calls, report: evaluateScenario({ fixtureId: scenarioId, deliveredCalls: calls, draft, finalResult }) };
}
