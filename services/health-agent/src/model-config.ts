import OpenAI from "openai";
import { OpenAIResponsesModel, type Model } from "@openai/agents";

export const MAX_TOOL_CALLS = 12;
export const MAX_MODEL_TURNS = 10;
export const RUN_TIMEOUT_MS = 90_000;
export const MODEL_TIMEOUT_MS = 90_000;
export const MAX_OUTPUT_TOKENS = 2_500;

export type ModelConfig = { modelId: string; requestTimeoutMs: number; maxOutputTokens: number };
export const DEFAULT_MODEL_CONFIG: Omit<ModelConfig, "modelId"> = { requestTimeoutMs: MODEL_TIMEOUT_MS, maxOutputTokens: MAX_OUTPUT_TOKENS };

export function createOpenAIModel(config: ModelConfig, apiKey: string): Model {
  if (apiKey.length === 0) throw new Error("MODEL_API_KEY_REQUIRED");
  return new OpenAIResponsesModel(new OpenAI({ apiKey, timeout: config.requestTimeoutMs }), config.modelId);
}
