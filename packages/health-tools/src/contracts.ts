import { z } from "zod";

import {
  CurrentContextResultSchema,
  EvidenceSchema,
  MAX_HISTORY_DAYS,
  MIN_HISTORY_DAYS,
  MissingEvidenceSchema,
  RecoveryHistoryResultSchema,
  SleepHistoryResultSchema,
  TrainingHistoryResultSchema,
  UserProfileResultSchema,
  type CurrentContextResult,
  type Evidence,
  type MetricObservation,
  type RecoveryDay,
  type SleepDay,
  type TrainingDay,
  type UserProfileResult
} from "@ahp/health-domain";

export const HEALTH_TOOL_NAMES = [
  "get_user_profile",
  "get_current_context",
  "get_sleep_history",
  "get_recovery_history",
  "get_recent_training"
] as const;

export type HealthToolName = (typeof HEALTH_TOOL_NAMES)[number];

export const DEFAULT_HISTORY_DAYS = 7;
export const MAX_TRAINING_SESSIONS_PER_WINDOW = 50;
export const MAX_TOOL_RESPONSE_BYTES = 64 * 1024;

export const EmptyToolInputSchema = z.strictObject({});
export const HistoryToolInputSchema = z.strictObject({
  days: z.number().int().min(MIN_HISTORY_DAYS).max(MAX_HISTORY_DAYS).optional()
});

const ToolEvidenceFieldsSchema = z.strictObject({
  missing: z.array(MissingEvidenceSchema)
});

export const SleepHistoryToolResultSchema = SleepHistoryResultSchema.extend({
  missing: ToolEvidenceFieldsSchema.shape.missing
});
export const RecoveryHistoryToolResultSchema = RecoveryHistoryResultSchema.extend({
  missing: ToolEvidenceFieldsSchema.shape.missing
});
export const TrainingHistoryToolResultSchema = TrainingHistoryResultSchema.extend({
  missing: ToolEvidenceFieldsSchema.shape.missing
});

export type HistoryToolInput = z.infer<typeof HistoryToolInputSchema>;
export type SleepHistoryToolResult = z.infer<typeof SleepHistoryToolResultSchema>;
export type RecoveryHistoryToolResult = z.infer<typeof RecoveryHistoryToolResultSchema>;
export type TrainingHistoryToolResult = z.infer<typeof TrainingHistoryToolResultSchema>;
export type HealthToolResult =
  | UserProfileResult
  | CurrentContextResult
  | SleepHistoryToolResult
  | RecoveryHistoryToolResult
  | TrainingHistoryToolResult;

export type SemanticHealthReaders = {
  get_user_profile(): UserProfileResult;
  get_current_context(): CurrentContextResult;
  get_sleep_history(input?: HistoryToolInput): SleepHistoryToolResult;
  get_recovery_history(input?: HistoryToolInput): RecoveryHistoryToolResult;
  get_recent_training(input?: HistoryToolInput): TrainingHistoryToolResult;
};

export const TOOL_RESULT_SCHEMAS = {
  get_user_profile: UserProfileResultSchema,
  get_current_context: CurrentContextResultSchema,
  get_sleep_history: SleepHistoryToolResultSchema,
  get_recovery_history: RecoveryHistoryToolResultSchema,
  get_recent_training: TrainingHistoryToolResultSchema
} as const;

export function isHealthToolName(name: string): name is HealthToolName {
  return (HEALTH_TOOL_NAMES as readonly string[]).includes(name);
}

export function evidenceFromToolResult(result: HealthToolResult): Evidence[] {
  const observations: MetricObservation[] = "observations" in result ? result.observations : result.days.flatMap(dayEvidenceObservations);

  return [
    ...observations.map((observation) => ({ kind: "observation" as const, observation })),
    ...result.missing
  ];
}

function dayEvidenceObservations(day: SleepDay | RecoveryDay | TrainingDay): MetricObservation[] {
  if ("duration" in day) return day.duration.status === "available" ? [day.duration.observation] : [];
  if ("readiness" in day) return [day.readiness, day.lowestSleepHeartRate].flatMap((state) => state.status === "available" ? [state.observation] : []);
  return day.sessions.flatMap((session) => [session.activity, session.duration].flatMap((state) => state.status === "available" ? [state.observation] : []));
}

export function validateToolResult(name: HealthToolName, value: unknown): HealthToolResult {
  return TOOL_RESULT_SCHEMAS[name].parse(value) as HealthToolResult;
}
