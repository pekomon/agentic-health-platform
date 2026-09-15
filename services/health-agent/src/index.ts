export { EvidenceLedger, isMissingEvidence } from "./ledger.js";
export type { DeliveredToolCall, LedgerErrorCode, LedgerResult, LedgerSnapshot } from "./ledger.js";
export { finalizeRecommendation, RECOMMENDATION_ERROR_CODES } from "./finalize.js";
export type { RecommendationError, RecommendationErrorCode, RecommendationResult } from "./finalize.js";

/**
 * Future model implementations receive only validated tool results and return
 * a draft. This slice deliberately supplies no live implementation.
 */
export type RecommendationModelAdapter = {
  generateDraft(input: { deliveredCalls: readonly import("./ledger.js").DeliveredToolCall[] }): Promise<unknown>;
};
