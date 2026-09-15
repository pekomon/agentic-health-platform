import type { DailyTrainingRecommendation } from "@ahp/health-domain";

import type { RecommendationResult } from "../src/finalize.js";
import type { ScenarioId } from "./scenarios.js";

export type EvalCheck = { id: string; passed: boolean; detailCode: string };
export type EvalReport = { scenarioId: ScenarioId; checks: EvalCheck[]; passed: boolean };

function resultValue(result: RecommendationResult): DailyTrainingRecommendation | null {
  return result.ok ? result.value : null;
}

function activityCheck(scenarioId: ScenarioId, recommendation: DailyTrainingRecommendation | null): EvalCheck {
  if (recommendation === null) return { id: "recommendation-produced", passed: false, detailCode: "NO_RECOMMENDATION" };
  const activeEasy = recommendation.intensity === "EASY" && ["WALKING", "MOBILITY"].includes(recommendation.activity);
  const passes = {
    well_recovered_runner: recommendation.activity === "RUNNING" && ["EASY", "MODERATE"].includes(recommendation.intensity),
    poor_sleep_low_recovery: recommendation.activity === "REST" || activeEasy,
    strength_goal_good_recovery: recommendation.activity === "STRENGTH" && ["EASY", "MODERATE"].includes(recommendation.intensity),
    late_evening_low_recovery: recommendation.activity === "REST" || activeEasy,
    missing_data: recommendation.activity === "REST" || activeEasy
  }[scenarioId];
  return { id: "activity-and-intensity", passed: passes, detailCode: passes ? "OK" : "UNEXPECTED_ACTIVITY_OR_INTENSITY" };
}

function durationCheck(scenarioId: ScenarioId, recommendation: DailyTrainingRecommendation | null): EvalCheck {
  if (recommendation === null) return { id: "duration", passed: false, detailCode: "NO_RECOMMENDATION" };
  const duration = recommendation.durationMinutes;
  const passes = recommendation.activity === "REST" || (duration !== undefined && {
    well_recovered_runner: duration >= 20 && duration <= 45,
    poor_sleep_low_recovery: duration <= 30,
    strength_goal_good_recovery: duration >= 20 && duration <= 50,
    late_evening_low_recovery: duration <= 20,
    missing_data: duration <= 20
  }[scenarioId]);
  return { id: "duration", passed: passes, detailCode: passes ? "OK" : "UNEXPECTED_DURATION" };
}

function evidenceCheck(recommendation: DailyTrainingRecommendation | null): EvalCheck {
  const passes = recommendation !== null && recommendation.claims.every((claim) => claim.evidenceIds.length > 0) && recommendation.evidence.length > 0;
  return { id: "cited-evidence", passed: passes, detailCode: passes ? "OK" : "MISSING_CITED_EVIDENCE" };
}

function missingCheck(scenarioId: ScenarioId, recommendation: DailyTrainingRecommendation | null): EvalCheck {
  const required = scenarioId === "missing_data";
  const passes = !required || (recommendation !== null && recommendation.limitations.some((entry) => entry.metric === "sleep.duration") && recommendation.limitations.some((entry) => entry.metric === "oura.readiness_score"));
  return { id: "missing-data-limitations", passed: passes, detailCode: passes ? "OK" : "MISSING_REQUIRED_LIMITATION" };
}

export function evaluateScenario(input: { fixtureId: ScenarioId; deliveredCalls: readonly unknown[]; draft: unknown; finalResult: RecommendationResult }): EvalReport {
  // deliveredCalls and draft intentionally remain part of this stable replay
  // contract for future transcript inspection; the finalizer has already
  // validated their relationship before assertions inspect the public output.
  void input.deliveredCalls;
  void input.draft;
  const recommendation = resultValue(input.finalResult);
  const checks = [activityCheck(input.fixtureId, recommendation), durationCheck(input.fixtureId, recommendation), evidenceCheck(recommendation), missingCheck(input.fixtureId, recommendation)];
  return { scenarioId: input.fixtureId, checks, passed: checks.every((check) => check.passed) };
}

export function compareConfidence(wellRecovered: RecommendationResult, missing: RecommendationResult): EvalCheck {
  const passes = wellRecovered.ok && missing.ok && missing.value.confidence < wellRecovered.value.confidence;
  return { id: "missing-confidence-lower", passed: passes, detailCode: passes ? "OK" : "CONFIDENCE_NOT_LOWER" };
}
