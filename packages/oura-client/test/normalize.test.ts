import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RecoveryHistoryResultSchema,
  SleepHistoryResultSchema,
  TrainingHistoryResultSchema
} from "@ahp/health-domain";

import { normalizeRecovery, normalizeSleep, normalizeTraining } from "../src/normalize/index.js";
import type {
  ProviderCollection,
  ReadinessDto,
  SleepDto,
  WorkoutDto
} from "../src/transport/index.js";

const window = { startDate: "2026-01-01", endDate: "2026-01-03" } as const;
const asOf = "2026-01-04T08:00:00Z" as const;
const complete = <T>(records: T[]): ProviderCollection<T> => ({
  records,
  complete: true,
  failure: null,
  fieldIssues: []
});
const sleep = (overrides: Partial<SleepDto> = {}): SleepDto => ({
  id: "sleep-1",
  day: "2026-01-01",
  bedtimeStart: "2026-01-01T22:00:00Z",
  bedtimeEnd: "2026-01-02T06:00:00Z",
  type: "long_sleep",
  totalSleepDuration: 27_000,
  lowestHeartRate: 48,
  ...overrides
});
const readiness = (overrides: Partial<ReadinessDto> = {}): ReadinessDto => ({
  id: "readiness-1",
  day: "2026-01-01",
  timestamp: "2026-01-01T08:00:00Z",
  score: 82,
  ...overrides
});
const workout = (overrides: Partial<WorkoutDto> = {}): WorkoutDto => ({
  id: "workout-1",
  day: "2026-01-01",
  startDatetime: "2026-03-29T01:30:00+02:00",
  endDatetime: "2026-03-29T03:30:00+03:00",
  activity: "running",
  ...overrides
});

describe("Oura REST normalization", () => {
  it("selects one primary long sleep deterministically and preserves canonical REST provenance", () => {
    const input = complete([
      sleep({ id: "nap", type: "rest", totalSleepDuration: 30_000 }),
      sleep({ id: "later", totalSleepDuration: 27_500, bedtimeEnd: "2026-01-02T07:00:00Z" }),
      sleep({ id: "winner-b", totalSleepDuration: 28_000, bedtimeEnd: "2026-01-02T06:30:00Z" }),
      sleep({ id: "winner-a", totalSleepDuration: 28_000, bedtimeEnd: "2026-01-02T06:30:00Z" })
    ]);
    const before = structuredClone(input);
    const result = normalizeSleep(input, window, asOf);

    expect(result.days[0]?.duration).toMatchObject({
      status: "available",
      observation: {
        value: 28_000,
        unit: "seconds",
        source: { kind: "oura", channel: "rest", datasetId: null },
        sourceRecordId: "winner-a",
        sourceField: "sleep.duration",
        effectiveDate: "2026-01-01",
        period: { start: "2026-01-01T22:00:00Z", end: "2026-01-02T06:30:00Z" }
      }
    });
    expect(result.days.slice(1).map((day) => day.duration)).toEqual([
      { status: "missing", reason: "not_recorded" },
      { status: "missing", reason: "not_recorded" }
    ]);
    expect(result.status).toBe("partial");
    expect(SleepHistoryResultSchema.safeParse(result).success).toBe(true);
    expect(input).toEqual(before);
  });

  it("uses ordinal ID ordering for primary-sleep ties", () => {
    const result = normalizeSleep(complete([
      sleep({ id: "ä", totalSleepDuration: 28_000 }),
      sleep({ id: "z", totalSleepDuration: 28_000 })
    ]), window, asOf);
    expect(result.days[0]?.duration).toMatchObject({ status: "available", observation: { sourceRecordId: "z" } });
  });

  it("distinguishes unsupported, invalid, empty, and partial sleep coverage", () => {
    const unknown = normalizeSleep(complete([sleep({ type: null })]), window, asOf);
    expect(unknown.days[0]?.duration).toEqual({ status: "missing", reason: "unsupported" });
    const futureType = normalizeSleep(complete([sleep({ type: "future_sleep_kind" })]), window, asOf);
    expect(futureType.days[0]?.duration).toEqual({ status: "missing", reason: "unsupported" });
    for (const type of ["deleted", "sleep", "late_nap", "rest"]) {
      const recognized = normalizeSleep(complete([sleep({ type })]), window, asOf);
      expect(recognized.days[0]?.duration).toEqual({ status: "missing", reason: "not_recorded" });
    }

    const invalid = normalizeSleep({
      ...complete([sleep({ totalSleepDuration: null })]),
      complete: false,
      fieldIssues: [{ recordId: "sleep-1", day: "2026-01-01", field: "total_sleep_duration", code: "invalid" }]
    }, window, asOf);
    expect(invalid.days[0]?.duration).toEqual({ status: "missing", reason: "invalid_provider_data" });

    const partial = normalizeSleep({
      ...complete([sleep()]),
      complete: false,
      failure: { code: "LIMIT_REACHED", retryable: false, retryAfterSeconds: null }
    }, window, asOf);
    expect(partial.days[0]?.duration.status).toBe("available");
    expect(partial.days.slice(1).every((day) => day.duration.status === "missing" && day.duration.reason === "truncated")).toBe(true);
    expect(partial.issues).toContainEqual({ code: "truncated", date: null, metric: null });

    const unexplainedIncomplete = normalizeSleep({
      ...complete([]),
      complete: false
    }, window, asOf);
    expect(unexplainedIncomplete.days.every((day) => day.duration.status === "missing" && day.duration.reason === "truncated")).toBe(true);
  });

  it("normalizes provider-specific recovery values and rejects ambiguous same-day readiness", () => {
    const sleeps = complete([
      sleep({ id: "shorter", totalSleepDuration: 20_000, lowestHeartRate: 41 }),
      sleep({ id: "primary", totalSleepDuration: 28_000, lowestHeartRate: 47 })
    ]);
    const result = normalizeRecovery(complete([readiness()]), sleeps, window, asOf);
    expect(result.days[0]?.readiness).toMatchObject({
      status: "available",
      observation: {
        value: 82,
        recordedAt: "2026-01-01T08:00:00Z",
        source: { kind: "oura", channel: "rest", datasetId: null },
        sourceRecordId: "readiness-1",
        sourceField: "oura.readiness_score"
      }
    });
    expect(result.days[0]?.lowestSleepHeartRate).toMatchObject({
      status: "available",
      observation: {
        value: 47,
        source: { kind: "oura", channel: "rest", datasetId: null },
        sourceRecordId: "primary",
        sourceField: "oura.sleep_lowest_heart_rate",
        unit: "bpm"
      }
    });
    expect(RecoveryHistoryResultSchema.safeParse(result).success).toBe(true);

    const ambiguous = normalizeRecovery(complete([
      readiness(),
      readiness({ id: "readiness-2", score: 90 })
    ]), sleeps, window, asOf);
    expect(ambiguous.days[0]?.readiness).toEqual({ status: "missing", reason: "invalid_provider_data" });
  });

  it("does not let an unselected sleep period's missing field qualify the selected recovery value", () => {
    const sleeps: ProviderCollection<SleepDto> = {
      ...complete([
        sleep({ id: "primary", totalSleepDuration: 28_000, lowestHeartRate: 47 }),
        sleep({ id: "unselected", totalSleepDuration: 20_000, lowestHeartRate: null })
      ]),
      complete: false,
      fieldIssues: [{ recordId: "unselected", day: "2026-01-01", field: "lowest_heart_rate", code: "invalid" }]
    };
    const result = normalizeRecovery(complete([readiness()]), sleeps, window, asOf);
    expect(result.days[0]?.lowestSleepHeartRate).toMatchObject({ status: "available", observation: { value: 47, sourceRecordId: "primary" } });
  });

  it("collapses identical records but rejects conflicting duplicate identities", () => {
    const value = sleep();
    expect(normalizeSleep(complete([value, structuredClone(value)]), window, asOf).days[0]?.duration.status).toBe("available");
    const reordered: SleepDto = {
      lowestHeartRate: value.lowestHeartRate,
      totalSleepDuration: value.totalSleepDuration,
      type: value.type,
      bedtimeEnd: value.bedtimeEnd,
      bedtimeStart: value.bedtimeStart,
      day: value.day,
      id: value.id
    };
    expect(normalizeSleep(complete([value, reordered]), window, asOf).days[0]?.duration.status).toBe("available");
    const conflict = normalizeSleep(complete([value, { ...value, totalSleepDuration: 10_000 }]), window, asOf);
    expect(conflict.days[0]?.duration).toEqual({ status: "missing", reason: "invalid_provider_data" });
  });

  it("treats null and non-finite readiness scores as conflicting in either record order", () => {
    const nullScore = readiness({ score: null });
    const invalidScore = readiness({ score: Number.NaN });
    for (const records of [[nullScore, invalidScore], [invalidScore, nullScore]]) {
      const result = normalizeRecovery(complete(records), complete([]), window, asOf);
      expect(result.days[0]?.readiness).toEqual({ status: "missing", reason: "invalid_provider_data" });
      expect(result.issues).toContainEqual({ code: "invalid_provider_data", date: "2026-01-01", metric: "oura.readiness_score" });
    }
  });

  it("maps only the approved workout activities and derives fractional elapsed seconds across DST", () => {
    const result = normalizeTraining(complete([
      workout(),
      workout({ id: "workout-2", startDatetime: "2026-01-01T10:00:00.250Z", endDatetime: "2026-01-01T10:30:00.750Z", activity: "yoga" }),
      workout({ id: "workout-3", startDatetime: "2026-01-01T11:00:00Z", endDatetime: "2026-01-01T11:20:00Z", activity: "strength_training" })
    ]), window, asOf);
    const sessions = result.days[0]?.sessions ?? [];
    expect(sessions.map((value) => value.activity.observation.value)).toEqual(["UNKNOWN", "STRENGTH", "RUNNING"]);
    expect(sessions.map((value) => value.duration.observation.value)).toEqual([1_800.5, 1_200, 3_600]);
    expect(sessions[0]?.activity.observation).toMatchObject({
      source: { kind: "oura", channel: "rest", datasetId: null },
      sourceRecordId: "workout-2",
      sourceField: "training.activity"
    });
    expect(sessions[0]?.duration.observation).toMatchObject({
      source: { kind: "oura", channel: "rest", datasetId: null },
      sourceRecordId: "workout-2",
      sourceField: "training.duration"
    });
    expect(sessions[0]?.duration.observation.derivation).toEqual({ method: "elapsed_seconds", inputFields: ["start", "end"] });
    expect(TrainingHistoryResultSchema.safeParse(result).success).toBe(true);
  });

  it("orders same-start workout sessions by ordinal ID", () => {
    const result = normalizeTraining(complete([
      workout({ id: "ä", startDatetime: "2026-01-01T10:00:00Z", endDatetime: "2026-01-01T10:30:00Z" }),
      workout({ id: "z", startDatetime: "2026-01-01T10:00:00Z", endDatetime: "2026-01-01T10:30:00Z" })
    ]), window, asOf);
    expect(result.days[0]?.sessions.map((session) => session.id)).toEqual(["z", "ä"]);
  });

  it("excludes invalid workout periods, preserves valid sessions on truncation, and accounts for every date", () => {
    const invalid = normalizeTraining(complete([
      workout(),
      workout({ id: "bad", startDatetime: "2026-01-01T12:00:00Z", endDatetime: "2026-01-01T11:00:00Z" })
    ]), window, asOf);
    expect(invalid.days[0]).toEqual({ date: "2026-01-01", status: "unavailable", sessions: [], reason: "invalid_provider_data" });

    const partial = normalizeTraining({
      ...complete([workout()]),
      complete: false,
      failure: { code: "PROVIDER_UNAVAILABLE", retryable: true, retryAfterSeconds: null }
    }, window, asOf);
    expect(partial.days).toHaveLength(3);
    expect(partial.days[0]?.status).toBe("partial");
    expect(partial.days[0]?.sessions).toHaveLength(1);
    expect(partial.days.slice(1).every((day) => day.status === "unavailable" && day.reason === "provider_unavailable")).toBe(true);
  });

  it("keeps Oura REST dependencies out of health-tools and health-agent", () => {
    for (const relative of ["../../health-tools/src", "../../../services/health-agent/src"]) {
      const root = resolve(import.meta.dirname, relative);
      for (const entry of readdirSync(root, { recursive: true, encoding: "utf8" })) {
        if (!entry.endsWith(".ts")) continue;
        expect(readFileSync(resolve(root, entry), "utf8")).not.toContain("@ahp/oura-client");
      }
    }
  });
});
