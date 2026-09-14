import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import type { SemanticHealthReaders, TrainingHistoryToolResult, UserProfileResult } from "../src/index.js";
import { connectHealthTools, createSyntheticHealthTools } from "../src/index.js";
import { loadFixture } from "./helpers.js";

function hex(index: number): string {
  return index.toString(16).padStart(64, "0").slice(-64);
}

function trainingSessions(count: number) {
  const source = { kind: "synthetic" as const, channel: "fixture" as const, datasetId: "well_recovered_runner" };
  return Array.from({ length: count }, (_, index) => {
    const startMinute = `${index}`.padStart(2, "0");
    const sessionId = `session-${startMinute}-${"x".repeat(240)}`.slice(0, 256);
    const start = `2026-01-14T08:${startMinute}:00+02:00`;
    const end = `2026-01-14T08:${startMinute}:30+02:00`;
    return {
      id: sessionId,
      date: "2026-01-14",
      start,
      end,
      activity: {
        status: "available" as const,
        observation: {
          id: `obs_${hex(index * 2 + 1)}`,
          metric: "training.activity" as const,
          value: "RUNNING" as const,
          unit: null,
          source,
          effectiveDate: "2026-01-14",
          period: { start, end },
          recordedAt: null,
          sourceRecordId: sessionId,
          sourceField: "training.activity" as const,
          derivation: null
        }
      },
      duration: {
        status: "available" as const,
        observation: {
          id: `obs_${hex(index * 2 + 2)}`,
          metric: "training.duration" as const,
          value: 30,
          unit: "seconds" as const,
          source,
          effectiveDate: "2026-01-14",
          period: { start, end },
          recordedAt: null,
          sourceRecordId: sessionId,
          sourceField: "training.duration" as const,
          derivation: { method: "elapsed_seconds" as const, inputFields: ["start", "end"] }
        }
      }
    };
  });
}

function largeTrainingResult(): TrainingHistoryToolResult {
  const sessions = trainingSessions(50);
  return {
    schemaVersion: 1,
    window: { startDate: "2026-01-14", endDate: "2026-01-14" },
    asOf: "2026-01-14T08:00:00+02:00",
    status: "complete",
    days: [{ date: "2026-01-14", status: "complete", sessions, reason: null }],
    issues: [],
    missing: []
  };
}

function readerWithProfile(profile: UserProfileResult): SemanticHealthReaders {
  const fixtureReaders = createSyntheticHealthTools(loadFixture());
  return {
    ...fixtureReaders,
    get_user_profile: () => profile
  };
}

describe("health tool boundaries", () => {
  it("retains exactly fifty fixture sessions without marking coverage as truncated", () => {
    const fixture = structuredClone(loadFixture());
    const sessions = trainingSessions(50);
    fixture.training[13] = { date: "2026-01-14", status: "complete", sessions, reason: null };

    const result = createSyntheticHealthTools(fixture).get_recent_training({ days: 1 });

    expect(result.days[0]).toMatchObject({ date: "2026-01-14", status: "complete", reason: null });
    expect(result.days[0]?.sessions.map((session) => session.id)).toEqual(sessions.map((session) => session.id));
    expect(result.issues).toEqual([]);
    expect(result.missing).toEqual([]);
  });

  it.each(["provider_unavailable", "unsupported"] as const)("keeps the newest fifty sessions in ascending order and preserves %s coverage evidence", (reason) => {
    const fixture = structuredClone(loadFixture());
    const sessions = trainingSessions(51);
    fixture.training[13] = { date: "2026-01-14", status: "partial", sessions, reason };

    const result = createSyntheticHealthTools(fixture).get_recent_training({ days: 1 });
    const day = result.days[0];

    expect(result.status).toBe("partial");
    expect(day).toMatchObject({ date: "2026-01-14", status: "partial", reason });
    expect(day?.sessions).toHaveLength(50);
    expect(day?.sessions.map((session) => session.id)).toEqual(sessions.slice(1).map((session) => session.id));
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([reason, "truncated"].sort());
    expect(result.missing.map((entry) => entry.reason).sort()).toEqual([reason, "truncated"].sort());
  });

  it("returns OUTPUT_LIMIT instead of oversized JSON", async () => {
    const readers = createSyntheticHealthTools(loadFixture());
    const largeReaders: SemanticHealthReaders = {
      ...readers,
      get_recent_training: () => largeTrainingResult()
    };
    const connection = await connectHealthTools(largeReaders);
    try {
      await expect(connection.callTool("get_recent_training", { days: 1 })).rejects.toThrow("OUTPUT_LIMIT");
    } finally {
      await connection.close();
    }
  });

  it("does not deliver evidence when server output validation fails", async () => {
    const readers = createSyntheticHealthTools(loadFixture());
    const invalidReaders: SemanticHealthReaders = {
      ...readers,
      get_user_profile: () => ({ schemaVersion: 1, profile: { goal: "ENDURANCE" }, observations: [], missing: [] }) as UserProfileResult
    };
    const connection = await connectHealthTools(invalidReaders);
    const delivered: unknown[] = [];
    connection.onDeliveredEvidence((evidence) => delivered.push(evidence));
    try {
      await expect(connection.callTool("get_user_profile")).rejects.toThrow("OUTPUT_VALIDATION_FAILED");
      expect(delivered).toHaveLength(0);
    } finally {
      await connection.close();
    }
  });

  it("maps arbitrary reader exceptions to static MCP errors", async () => {
    const readers = createSyntheticHealthTools(loadFixture());
    const throwingReaders: SemanticHealthReaders = {
      ...readers,
      get_sleep_history: () => {
        throw new Error("CANARY_TOP_SECRET");
      }
    };
    const connection = await connectHealthTools(throwingReaders);
    try {
      let message = "";
      await connection.callTool("get_sleep_history").catch((error: unknown) => {
        message = error instanceof Error ? error.message : String(error);
      });
      expect(message).toBe("INTERNAL_ERROR");
      expect(message).not.toContain("CANARY_TOP_SECRET");
    } finally {
      await connection.close();
    }
  });

  it("fails closed when a delivered evidence ID changes meaning across calls", async () => {
    const first = createSyntheticHealthTools(loadFixture("well_recovered_runner")).get_user_profile();
    const second = structuredClone(first);
    second.profile = { goal: "STRENGTH", customGoal: null, allowedTrainingTypes: ["STRENGTH"] };
    second.observations[0] = { ...second.observations[0]!, value: "STRENGTH" };
    second.observations[1] = { ...second.observations[1]!, value: ["STRENGTH"] };

    let calls = 0;
    const connection = await connectHealthTools(readerWithProfile(first));
    const changingReaders = readerWithProfile(first);
    changingReaders.get_user_profile = () => (++calls === 1 ? first : second);
    await connection.close();

    const changingConnection = await connectHealthTools(changingReaders);
    try {
      await changingConnection.callTool("get_user_profile");
      await expect(changingConnection.callTool("get_user_profile")).rejects.toThrow("CONFLICTING_EVIDENCE");
    } finally {
      await changingConnection.close();
    }
  });

  it("does not import the future Oura client package from health-tools", () => {
    const root = resolve(import.meta.dirname, "../src");
    for (const file of ["contracts.ts", "synthetic-reader.ts", "server.ts", "client.ts", "index.ts"]) {
      expect(readFileSync(resolve(root, file), "utf8")).not.toContain("oura-client");
    }
  });
});
