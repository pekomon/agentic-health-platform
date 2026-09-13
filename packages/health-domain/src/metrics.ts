import { z } from "zod";

import { InstantSchema, ObservationFieldsSchema, SleepDurationObservationSchema } from "./observation.js";
import { AllowedTrainingTypesSchema, ExerciseTrainingTypeSchema, MAX_CUSTOM_GOAL_LENGTH, TrainingGoalSchema } from "./profile.js";
import { MAX_AVAILABLE_MINUTES } from "./context.js";

function observation<const M extends string, V extends z.ZodType, U extends z.ZodType>(metric: M, value: V, unit: U, sourceField: M) {
  return ObservationFieldsSchema.extend({ metric: z.literal(metric), value, unit, sourceField: z.literal(sourceField), derivation: z.null() });
}

export const ReadinessObservationSchema = observation("oura.readiness_score", z.number().int().min(0).max(100), z.literal("score"), "oura.readiness_score");
export const LowestSleepHeartRateObservationSchema = observation("oura.sleep_lowest_heart_rate", z.number().int().positive(), z.literal("bpm"), "oura.sleep_lowest_heart_rate");
export const TrainingActivityObservationSchema = observation("training.activity", z.union([ExerciseTrainingTypeSchema, z.literal("UNKNOWN")]), z.null(), "training.activity");
export const TrainingDurationObservationSchema = observation("training.duration", z.number().finite().positive(), z.literal("seconds"), "training.duration")
  .extend({ derivation: z.strictObject({ method: z.literal("elapsed_seconds"), inputFields: z.tuple([z.literal("start"), z.literal("end")]) }).nullable() })
  .superRefine((value, context) => {
    if (value.derivation !== null && (value.period === null || value.value !== (Date.parse(value.period.end) - Date.parse(value.period.start)) / 1000)) context.addIssue({ code: "custom", message: "derived duration must match period" });
  });
export const ProfileGoalObservationSchema = observation("profile.goal", TrainingGoalSchema, z.null(), "profile.goal");
export const ProfileCustomGoalObservationSchema = observation("profile.custom_goal", z.string().min(1).max(MAX_CUSTOM_GOAL_LENGTH), z.null(), "profile.custom_goal");
export const ProfileAllowedTypesObservationSchema = observation("profile.allowed_training_types", AllowedTrainingTypesSchema, z.null(), "profile.allowed_training_types");
export const ContextLocalTimeObservationSchema = observation("context.local_time", InstantSchema, z.null(), "context.local_time");
export const ContextBedtimeObservationSchema = observation("context.bedtime", InstantSchema, z.null(), "context.bedtime");
export const ContextAvailableMinutesObservationSchema = observation("context.available_minutes", z.number().int().min(0).max(MAX_AVAILABLE_MINUTES), z.literal("minutes"), "context.available_minutes");

export const MetricObservationSchema = z.discriminatedUnion("metric", [
  SleepDurationObservationSchema, ReadinessObservationSchema, LowestSleepHeartRateObservationSchema,
  TrainingActivityObservationSchema, TrainingDurationObservationSchema, ProfileGoalObservationSchema,
  ProfileCustomGoalObservationSchema, ProfileAllowedTypesObservationSchema, ContextLocalTimeObservationSchema,
  ContextBedtimeObservationSchema, ContextAvailableMinutesObservationSchema
]);
export const MetricSchema = z.enum(MetricObservationSchema.options.map((schema) => schema.shape.metric.value));
export const EvidenceMetricSchema = z.union([MetricSchema, z.literal("training.sessions")]);
export type MetricObservation = z.infer<typeof MetricObservationSchema>;
export type Metric = z.infer<typeof MetricSchema>;
