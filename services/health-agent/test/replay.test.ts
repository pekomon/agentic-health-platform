import { describe, expect, it } from "vitest";

import { compareConfidence, evaluateScenario } from "../evals/assertions.js";
import { replayScenario } from "../evals/replay.js";
import { SCENARIO_IDS } from "../evals/scenarios.js";
import { fixtureRootFor } from "../evals/scenarios.js";
import { resolve } from "node:path";

describe("deterministic synthetic replay", () => {
  it("finalizes all allowlisted scenario transcripts through MCP", async () => {
    for (const scenarioId of SCENARIO_IDS) {
      const replay = await replayScenario(scenarioId);
      expect(replay.finalResult.ok).toBe(true);
      expect(replay.report.passed).toBe(true);
      expect(replay.calls.map((call) => call.name)).toEqual([
        "get_user_profile", "get_current_context", "get_sleep_history", "get_recovery_history", "get_recent_training"
      ]);
    }
  });

  it("is deterministic for the same replay transcript", async () => {
    const first = await replayScenario("poor_sleep_low_recovery");
    const second = await replayScenario("poor_sleep_low_recovery");
    expect(second).toEqual(first);
  });

  it("requires lower confidence for the scripted missing-data replay", async () => {
    const wellRecovered = await replayScenario("well_recovered_runner");
    const missing = await replayScenario("missing_data");
    expect(compareConfidence(wellRecovered.finalResult, missing.finalResult)).toMatchObject({ passed: true });
  });

  it("proves every scenario assertion rejects a targeted bad outcome", async () => {
    for (const scenarioId of SCENARIO_IDS) {
      const replay = await replayScenario(scenarioId);
      if (!replay.finalResult.ok) throw new Error("expected valid replay");
      const badResult = {
        ok: true as const,
        value: { ...replay.finalResult.value, activity: "RUNNING" as const, intensity: "MODERATE" as const, durationMinutes: 60 }
      };
      const report = evaluateScenario({ fixtureId: scenarioId, deliveredCalls: replay.calls, draft: replay.draft, finalResult: badResult });
      expect(report.passed).toBe(false);
    }
  });

  it("locates fixtures from both source and compiled eval module layouts", () => {
    expect(fixtureRootFor(resolve(import.meta.dirname, "../evals"))).toMatch(/fixtures\/synthetic$/);
    expect(fixtureRootFor(resolve(import.meta.dirname, "../dist/evals"))).toMatch(/fixtures\/synthetic$/);
  });
});
