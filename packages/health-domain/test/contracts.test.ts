import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  CurrentContextSchema,
  RecommendationDraftSchema,
  UserTrainingProfileSchema,
  makeHistoryWindow,
  validateFixture
} from "../src/index.js";

const fixturesRoot = resolve(import.meta.dirname, "../../../fixtures/synthetic");
type ScenarioSummary = {
  sleep: Array<{ duration: { status: string; observation?: { value: number } } }>;
  recovery: Array<{ readiness: { status: string; observation?: { value: number } } }>;
  training: Array<{ status: string; sessions: unknown[] }>;
};

describe("deterministic recommendation contracts", () => {
  it("creates inclusive 1- and 14-day calendar windows", () => {
    expect(makeHistoryWindow("2026-01-14", 1)).toEqual({ startDate: "2026-01-14", endDate: "2026-01-14" });
    expect(makeHistoryWindow("2026-01-14", 14)).toEqual({ startDate: "2026-01-01", endDate: "2026-01-14" });
    expect(() => makeHistoryWindow("2026-01-14", 0)).toThrow(RangeError);
    expect(() => makeHistoryWindow("2026-01-14", 15)).toThrow(RangeError);
  });

  it("rejects duplicate preferences and REST as a user exercise preference", () => {
    expect(UserTrainingProfileSchema.safeParse({ goal: "ENDURANCE", customGoal: null, allowedTrainingTypes: ["RUNNING", "RUNNING"] }).success).toBe(false);
    expect(UserTrainingProfileSchema.safeParse({ goal: "ENDURANCE", customGoal: null, allowedTrainingTypes: ["REST"] }).success).toBe(false);
    expect(UserTrainingProfileSchema.safeParse({ goal: "OTHER", customGoal: null, allowedTrainingTypes: ["WALKING"] }).success).toBe(true);
  });

  it("keeps optional current context explicit and bounds bedtime", () => {
    expect(CurrentContextSchema.safeParse({ localTime: "2026-01-14T08:00:00+02:00", timeZone: "Europe/Helsinki", bedtime: null, availableMinutes: null }).success).toBe(true);
    expect(CurrentContextSchema.safeParse({ localTime: "2026-01-14T08:00:00+02:00", timeZone: "Europe/Helsinki", bedtime: "2026-01-15T09:00:01+02:00", availableMinutes: 20 }).success).toBe(false);
  });

  it("requires a structurally valid, constraint-compatible draft", () => {
    const active = { activity: "RUNNING", intensity: "EASY", durationMinutes: 30, targetHeartRateZone: null, rationaleClaims: [{ text: "Use available context.", evidenceIds: ["obs_a"] }], confidence: 0.5, limitationIds: [] };
    expect(RecommendationDraftSchema.safeParse(active).success).toBe(true);
    expect(RecommendationDraftSchema.safeParse({ ...active, activity: "REST" }).success).toBe(false);
    expect(RecommendationDraftSchema.safeParse({ ...active, targetHeartRateZone: {} }).success).toBe(false);
  });

  it.each([
    "well_recovered_runner", "poor_sleep_low_recovery", "strength_goal_good_recovery", "late_evening_low_recovery", "missing_data"
  ])("validates the %s synthetic scenario", (scenarioId) => {
    const fixture = JSON.parse(readFileSync(resolve(fixturesRoot, `${scenarioId}.json`), "utf8")) as unknown;
    const result = validateFixture(fixture);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.sleep).toHaveLength(14);
      expect(result.value.recovery).toHaveLength(14);
      expect(result.value.training).toHaveLength(14);
    }
  });

  it("keeps scenario contrasts in fixture data rather than model-visible expectations", () => {
    const load = (scenarioId: string): ScenarioSummary => JSON.parse(readFileSync(resolve(fixturesRoot, `${scenarioId}.json`), "utf8")) as ScenarioSummary;
    const healthy = load("well_recovered_runner");
    const poor = load("poor_sleep_low_recovery");
    const missing = load("missing_data");
    expect(healthy.sleep.every((day) => day.duration.observation?.value === 28_800)).toBe(true);
    expect(healthy.recovery.every((day) => day.readiness.observation?.value === 85)).toBe(true);
    expect(poor.sleep.slice(-3).every((day) => day.duration.observation?.value === 16_200)).toBe(true);
    expect(poor.recovery.slice(-3).every((day) => day.readiness.observation?.value === 40)).toBe(true);
    expect(missing.sleep.every((day) => day.duration.status === "missing")).toBe(true);
    expect(missing.training.every((day) => day.status === "unavailable" && day.sessions.length === 0)).toBe(true);
  });
});
