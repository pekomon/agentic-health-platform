export { EvidenceLedger, isMissingEvidence } from "./ledger.js";
export type { DeliveredToolCall, LedgerErrorCode, LedgerResult, LedgerSnapshot } from "./ledger.js";
export { finalizeRecommendation, RECOMMENDATION_ERROR_CODES } from "./finalize.js";
export type { RecommendationError, RecommendationErrorCode, RecommendationResult } from "./finalize.js";
export { recommendSynthetic } from "./agent.js";
export type { RecommendSyntheticDependencies, SyntheticRecommendationRequest } from "./agent.js";
export { createOpenAIModel, DEFAULT_MODEL_CONFIG, MAX_MODEL_TURNS, MAX_OUTPUT_TOKENS, MAX_TOOL_CALLS, MODEL_TIMEOUT_MS, RUN_TIMEOUT_MS } from "./model-config.js";
export type { ModelConfig } from "./model-config.js";

/**
 * Future model implementations receive only validated tool results and return
 * a draft. This slice deliberately supplies no live implementation.
 */
export type RecommendationModelAdapter = {
  generateDraft(input: { deliveredCalls: readonly import("./ledger.js").DeliveredToolCall[] }): Promise<unknown>;
};
