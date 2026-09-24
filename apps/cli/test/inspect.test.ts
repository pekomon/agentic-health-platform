import { describe, expect, it, vi } from "vitest";

import { runInspectCommand } from "../src/inspect.js";
import {
  OuraRestTransport,
  type ProviderCollection,
  type ProviderFailure,
  type ReadinessDto,
  type SleepDto,
  type WorkoutDto
} from "@ahp/oura-client/transport";

const complete = <T>(records: T[]): ProviderCollection<T> => ({
  records,
  complete: true,
  failure: null,
  fieldIssues: []
});
const sleep: SleepDto = {
  id: "canary-sleep-record",
  day: "2026-01-01",
  bedtimeStart: "2025-12-31T22:00:00Z",
  bedtimeEnd: "2026-01-01T06:00:00Z",
  type: "long_sleep",
  totalSleepDuration: 27_000,
  lowestHeartRate: 48
};
const readiness: ReadinessDto = {
  id: "canary-readiness-record",
  day: "2026-01-01",
  timestamp: "2026-01-01T08:00:00Z",
  score: 82
};
const workout: WorkoutDto = {
  id: "canary-workout-record",
  day: "2026-01-01",
  startDatetime: "2026-01-01T10:00:00Z",
  endDatetime: "2026-01-01T10:30:00Z",
  activity: "running"
};
const clock = () => new Date("2026-01-01T12:00:00Z");
const transport = (overrides: Record<string, unknown> = {}) => ({
  listSleep: vi.fn(async () => complete([sleep])),
  listReadiness: vi.fn(async () => complete([readiness])),
  listWorkouts: vi.fn(async () => complete([workout])),
  ...overrides
});
const failed = <T>(failure: ProviderFailure): ProviderCollection<T> => ({
  records: [],
  complete: false,
  failure,
  fieldIssues: []
});

describe("health inspect", () => {
  it("renders aggregate coverage without values or record identifiers by default", async () => {
    const lines: string[] = [];
    const fake = transport();
    expect(await runInspectCommand(["--days", "1"], (line) => lines.push(line), { transport: fake, clock })).toBe(0);
    expect(lines).toEqual([
      "Local Oura REST inspection (no model or agent use).",
      "Window: 2026-01-01 through 2026-01-01.",
      "Sleep: complete; 1/1 dates available; dates 2026-01-01.",
      "Recovery: complete; readiness 1/1; lowest sleep heart rate 1/1; dates 2026-01-01.",
      "Training: complete; 1 sessions across 1/1 dates; dates 2026-01-01."
    ]);
    expect(JSON.stringify(lines)).not.toContain("27000");
    expect(JSON.stringify(lines)).not.toContain("canary-");
    expect(fake.listSleep).toHaveBeenCalledWith({ startDate: "2026-01-01", endDate: "2026-01-01" });
  });

  it("shows normalized values only with the explicit flag", async () => {
    const lines: string[] = [];
    expect(await runInspectCommand(["--days=1", "--show-values"], (line) => lines.push(line), { transport: transport(), clock })).toBe(0);
    expect(lines).toContain("Sleep values: 2026-01-01=27000 seconds.");
    expect(lines).toContain("Readiness values: 2026-01-01=82 score.");
    expect(lines).toContain("Lowest sleep heart-rate values: 2026-01-01=48 bpm.");
    expect(lines).toContain("Training values: 2026-01-01=RUNNING/1800 seconds.");
    expect(JSON.stringify(lines)).not.toContain("canary-");
  });

  it("runs from fabricated REST responses through projection, normalization, and CLI rendering", async () => {
    const response = (data: unknown) => new Response(JSON.stringify({ data: [data], next_token: null }));
    const fetch = vi.fn(async (input: URL) => response(
      input.pathname.endsWith("/sleep")
        ? { id: "raw-sleep", day: "2026-01-01", bedtime_start: "2025-12-31T22:00:00Z", bedtime_end: "2026-01-01T06:00:00Z", type: "long_sleep", total_sleep_duration: 27_000, lowest_heart_rate: 48, hidden: "canary-raw" }
        : input.pathname.endsWith("/daily_readiness")
          ? { id: "raw-readiness", day: "2026-01-01", timestamp: "2026-01-01T08:00:00Z", score: 82, hidden: "canary-raw" }
          : { id: "raw-workout", day: "2026-01-01", start_datetime: "2026-01-01T10:00:00Z", end_datetime: "2026-01-01T10:30:00Z", activity: "running", hidden: "canary-raw" }
    ));
    const session = {
      getStatus: vi.fn(async () => ({ ok: true, value: { state: "authenticated", expiresAt: "2026-01-02T00:00:00Z", grantedScopes: ["daily", "workout"] } })),
      withAccessToken: vi.fn(async (fn: (token: string) => Promise<unknown>) => ({ ok: true, value: await fn("canary-token") })),
      refreshAfterUnauthorized: vi.fn()
    };
    const lines: string[] = [];
    expect(await runInspectCommand(["--days", "1", "--show-values"], (line) => lines.push(line), {
      clock,
      transport: new OuraRestTransport(session as never, { fetch: fetch as typeof globalThis.fetch })
    })).toBe(0);
    expect(lines).toContain("Sleep values: 2026-01-01=27000 seconds.");
    expect(lines).toContain("Training values: 2026-01-01=RUNNING/1800 seconds.");
    expect(JSON.stringify(lines)).not.toContain("canary");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("rejects invalid, unknown, positional, and duplicate arguments before provider access", async () => {
    for (const args of [
      [], ["--days", "0"], ["--days", "15"], ["--days", "01"], ["--days", "1", "extra"],
      ["--save", "x"], ["--days", "1", "--days", "2"], ["--days", "1", "--show-values", "--show-values"]
    ]) {
      const fake = transport();
      const lines: string[] = [];
      expect(await runInspectCommand(args, (line) => lines.push(line), { transport: fake, clock })).toBe(2);
      expect(lines).toEqual(["Usage: health inspect --days <1..14> [--show-values]"]);
      expect(fake.listSleep).not.toHaveBeenCalled();
      expect(fake.listReadiness).not.toHaveBeenCalled();
      expect(fake.listWorkouts).not.toHaveBeenCalled();
    }
  });

  it("retains a partial inspection when another collection is unavailable", async () => {
    const lines: string[] = [];
    const unavailable: ProviderFailure = { code: "PROVIDER_UNAVAILABLE", retryable: true, retryAfterSeconds: null };
    expect(await runInspectCommand(["--days", "1"], (line) => lines.push(line), {
      clock,
      transport: transport({ listWorkouts: vi.fn(async () => failed<WorkoutDto>(unavailable)) })
    })).toBe(0);
    expect(lines.at(-1)).toBe("Training: unavailable; 0 sessions across 0/1 dates; dates none.");
  });

  it("maps complete provider failure, authentication, and cancellation to stable static outcomes", async () => {
    const cases: Array<[ProviderFailure, number, string]> = [
      [{ code: "PROVIDER_UNAVAILABLE", retryable: true, retryAfterSeconds: null }, 4, "Oura history is temporarily unavailable."],
      [{ code: "AUTHENTICATION_REQUIRED", retryable: false, retryAfterSeconds: null }, 3, "No usable Oura session is available. Run health auth login."],
      [{ code: "CANCELLED", retryable: true, retryAfterSeconds: null }, 130, "History inspection was cancelled."]
    ];
    for (const [failure, code, message] of cases) {
      const lines: string[] = [];
      expect(await runInspectCommand(["--days", "1"], (line) => lines.push(line), {
        clock,
        transport: {
          listSleep: async () => failed<SleepDto>(failure),
          listReadiness: async () => failed<ReadinessDto>(failure),
          listWorkouts: async () => failed<WorkoutDto>(failure)
        }
      })).toBe(code);
      expect(lines).toEqual([message]);
    }
  });

  it("does not expose thrown provider diagnostics", async () => {
    const lines: string[] = [];
    expect(await runInspectCommand(["--days", "1"], (line) => lines.push(line), {
      clock,
      transport: transport({ listSleep: vi.fn(async () => { throw new Error("canary token and payload"); }) })
    })).toBe(4);
    expect(lines).toEqual(["Oura history is temporarily unavailable."]);
  });
});
