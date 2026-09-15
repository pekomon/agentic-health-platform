import { describe, expect, it } from "vitest";
import { ScriptedModel, assistantMessage, functionCall } from "@openai/agents/testing";

import { recommendSynthetic } from "../src/agent.js";
import { replayScenario } from "../evals/replay.js";

describe("recommendSynthetic", () => {
  it("uses the actual MCP bridge before publishing a structured recommendation", async () => {
    const expected = (await replayScenario("well_recovered_runner")).draft;
    const model = new ScriptedModel([
      [functionCall("get_user_profile", {}, { callId: "profile" })],
      [functionCall("get_current_context", {}, { callId: "context" })],
      [functionCall("get_sleep_history", { days: 14 }, { callId: "sleep" })],
      [functionCall("get_recovery_history", { days: 14 }, { callId: "recovery" })],
      [functionCall("get_recent_training", { days: 14 }, { callId: "training" })],
      [assistantMessage(JSON.stringify(expected))]
    ]);

    const result = await recommendSynthetic({ scenarioId: "well_recovered_runner", modelId: "test-model" }, { model });

    expect(result.ok).toBe(true);
    expect(model.calls).toHaveLength(6);
    model.assertComplete();
  });

  it("blocks an unallowlisted scenario before a model call", async () => {
    const model = new ScriptedModel();
    const result = await recommendSynthetic({ scenarioId: "not-a-scenario" as never, modelId: "test-model" }, { model });
    expect(result).toEqual({ ok: false, error: { code: "POLICY_BLOCKED" } });
    expect(model.calls).toHaveLength(0);
  });

  it("allows one static-code repair after deterministic grounding rejects a draft", async () => {
    const expected = (await replayScenario("well_recovered_runner")).draft;
    const invalid = structuredClone(expected);
    invalid.rationaleClaims[0].evidenceIds[0] = "obs_not_delivered";
    const model = new ScriptedModel([
      [functionCall("get_user_profile", {}, { callId: "profile" })],
      [functionCall("get_current_context", {}, { callId: "context" })],
      [functionCall("get_sleep_history", { days: 14 }, { callId: "sleep" })],
      [functionCall("get_recovery_history", { days: 14 }, { callId: "recovery" })],
      [functionCall("get_recent_training", { days: 14 }, { callId: "training" })],
      [assistantMessage(JSON.stringify(invalid))],
      [assistantMessage(JSON.stringify(expected))]
    ]);
    const result = await recommendSynthetic({ scenarioId: "well_recovered_runner", modelId: "test-model" }, { model });
    expect(result.ok).toBe(true);
    expect(model.calls).toHaveLength(7);
    const repairInput = model.calls[6]?.request.input;
    const serializedRepairInput = JSON.stringify(repairInput);
    expect(serializedRepairInput).toContain("UNGROUNDED_EVIDENCE");
    expect(serializedRepairInput).toContain("obs_not_delivered");
    expect(serializedRepairInput).toContain(expected.rationaleClaims[0].evidenceIds[0]);
    model.assertComplete();
  });
});
