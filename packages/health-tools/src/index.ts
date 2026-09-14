export {
  DEFAULT_HISTORY_DAYS,
  HEALTH_TOOL_NAMES,
  HistoryToolInputSchema,
  MAX_TOOL_RESPONSE_BYTES,
  MAX_TRAINING_SESSIONS_PER_WINDOW,
  RecoveryHistoryToolResultSchema,
  SleepHistoryToolResultSchema,
  TrainingHistoryToolResultSchema,
  evidenceFromToolResult,
  isHealthToolName,
  validateToolResult
} from "./contracts.js";
export type {
  HealthToolName,
  HealthToolResult,
  HistoryToolInput,
  RecoveryHistoryToolResult,
  SemanticHealthReaders,
  SleepHistoryToolResult,
  TrainingHistoryToolResult
} from "./contracts.js";
export { createSyntheticHealthTools, expectedFixtureDates } from "./synthetic-reader.js";
export { createHealthToolsServer } from "./server.js";
export { connectHealthTools } from "./client.js";
export type { DeliveredEvidenceListener, HealthToolsConnection } from "./client.js";

