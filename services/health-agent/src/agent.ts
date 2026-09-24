import { Agent, ModelBehaviorError, ModelRefusalError, ModelTimeoutError, Runner, tool, type Model } from "@openai/agents";
import { z } from "zod";
import {
  RecommendationDraftSchema
} from "@ahp/health-domain";
import { HistoryToolInputSchema, connectHealthTools, createSyntheticHealthTools, type HealthToolName, type HealthToolsConnection } from "@ahp/health-tools";

import { finalizeRecommendation, type RecommendationError, type RecommendationResult } from "./finalize.js";
import { RECOMMENDATION_INSTRUCTIONS } from "./instructions.js";
import { EvidenceLedger } from "./ledger.js";
import { MAX_MODEL_TURNS, MAX_OUTPUT_TOKENS, MAX_TOOL_CALLS, MODEL_TIMEOUT_MS, RUN_TIMEOUT_MS, type ModelConfig } from "./model-config.js";
import { loadScenarioFixture, SCENARIO_IDS, type ScenarioId } from "../evals/scenarios.js";

export type RecommendSyntheticDependencies = {
  model: Model;
  connect?: (scenarioId: ScenarioId) => Promise<HealthToolsConnection>;
  modelConfig?: Omit<ModelConfig, "modelId">;
  onToolCall?: (name: HealthToolName) => void;
  signal?: AbortSignal;
};
export type SyntheticRecommendationRequest = { scenarioId: ScenarioId; modelId: string };

export function isSyntheticScenarioId(value: string): value is ScenarioId {
  return (SCENARIO_IDS as readonly string[]).includes(value);
}
function failure(code: RecommendationError["code"]): RecommendationResult { return { ok: false, error: { code } }; }
function safeError(error: unknown): RecommendationResult {
  if (error instanceof ModelRefusalError) return failure("MODEL_REFUSAL");
  if (error instanceof ModelTimeoutError || error instanceof DOMException && error.name === "AbortError") return failure("RUN_LIMIT");
  if (error instanceof ModelBehaviorError) return failure("INVALID_OUTPUT");
  return failure("MODEL_UNAVAILABLE");
}

function repairInput(rejectedDraft: unknown, code: RecommendationError["code"], ledger: EvidenceLedger): string {
  const evidence = [...ledger.snapshot().evidence.values()];
  return JSON.stringify({
    task: "Repair the rejected structured recommendation without calling tools.",
    validationCode: code,
    rejectedDraft,
    deliveredEvidence: evidence,
    instruction: "Return only a corrected structured draft. Cite only IDs in deliveredEvidence."
  });
}

function createTools(connection: HealthToolsConnection, ledger: EvidenceLedger, count: { value: number }, onToolCall?: (name: HealthToolName) => void) {
  const call = async (name: HealthToolName, input: Record<string, unknown>) => {
    count.value += 1;
    if (count.value > MAX_TOOL_CALLS) throw new Error("TOOL_CALL_LIMIT");
    const result = await connection.callTool(name, input);
    onToolCall?.(name);
    const recorded = ledger.record({ name, result });
    if (!recorded.ok) throw new Error(recorded.error.code);
    return JSON.stringify(result);
  };
  return [
    tool({ name: "get_user_profile", description: "Get the user's stated training goal and permitted activities.", parameters: z.strictObject({}), execute: () => call("get_user_profile", {}) }),
    tool({ name: "get_current_context", description: "Get current local time, bedtime, and available training minutes.", parameters: z.strictObject({}), execute: () => call("get_current_context", {}) }),
    tool({ name: "get_sleep_history", description: "Get bounded recent sleep history with evidence.", parameters: HistoryToolInputSchema, execute: (input) => call("get_sleep_history", input) }),
    tool({ name: "get_recovery_history", description: "Get bounded recent recovery history with evidence.", parameters: HistoryToolInputSchema, execute: (input) => call("get_recovery_history", input) }),
    tool({ name: "get_recent_training", description: "Get bounded recent training history with evidence.", parameters: HistoryToolInputSchema, execute: (input) => call("get_recent_training", input) })
  ];
}

export async function recommendSynthetic(request: SyntheticRecommendationRequest, dependencies: RecommendSyntheticDependencies): Promise<RecommendationResult> {
  if (!isSyntheticScenarioId(request.scenarioId)) return failure("POLICY_BLOCKED");
  const ledger = new EvidenceLedger();
  const controller = new AbortController();
  const abort = () => controller.abort();
  if (dependencies.signal?.aborted) abort();
  dependencies.signal?.addEventListener("abort", abort, { once: true });
  const deadline = setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
  const connect = dependencies.connect ?? (async (scenarioId: ScenarioId) => connectHealthTools(createSyntheticHealthTools(loadScenarioFixture(scenarioId))));
  let connection: HealthToolsConnection | undefined;
  try {
    connection = await connect(request.scenarioId);
    const count = { value: 0 };
    const agent = new Agent({ name: "Synthetic training recommender", instructions: RECOMMENDATION_INSTRUCTIONS, model: dependencies.model, tools: createTools(connection, ledger, count, dependencies.onToolCall), outputType: RecommendationDraftSchema, modelSettings: { maxTokens: dependencies.modelConfig?.maxOutputTokens ?? MAX_OUTPUT_TOKENS, timeoutMs: dependencies.modelConfig?.requestTimeoutMs ?? MODEL_TIMEOUT_MS, store: false, parallelToolCalls: false } });
    const runner = new Runner({ tracingDisabled: true, traceIncludeSensitiveData: false, modelSettings: { store: false } });
    const runOptions = { signal: controller.signal, toolExecution: { maxFunctionToolConcurrency: 1 } } as const;
    const run = await runner.run(agent, "Produce one daily training recommendation from the available tools.", { ...runOptions, maxTurns: MAX_MODEL_TURNS - 1 });
    const final = finalizeRecommendation(run.finalOutput, ledger.snapshot());
    if (final.ok) return final;
    // A separate runner invocation has no implicit history. Carry only the
    // rejected draft and already delivered synthetic evidence forward; no
    // environment values, secrets, raw errors, or new tool calls are needed.
    const repaired = await runner.run(agent, repairInput(run.finalOutput, final.error.code, ledger), { ...runOptions, maxTurns: 1 });
    return finalizeRecommendation(repaired.finalOutput, ledger.snapshot());
  } catch (error) {
    if (error instanceof Error && error.message === "TOOL_CALL_LIMIT") return failure("RUN_LIMIT");
    return safeError(error);
  } finally {
    clearTimeout(deadline);
    dependencies.signal?.removeEventListener("abort", abort);
    ledger.clear();
    await connection?.close();
  }
}
