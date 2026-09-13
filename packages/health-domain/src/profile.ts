import { z } from "zod";

export const TRAINING_GOALS = [
  "GENERAL_FITNESS", "ENDURANCE", "STRENGTH", "MUSCLE_GAIN", "WEIGHT_MANAGEMENT", "RECOVERY", "OTHER"
] as const;
export const TRAINING_TYPES = ["RUNNING", "WALKING", "CYCLING", "STRENGTH", "MOBILITY", "REST"] as const;
export const EXERCISE_TRAINING_TYPES = ["RUNNING", "WALKING", "CYCLING", "STRENGTH", "MOBILITY"] as const;

export const TrainingGoalSchema = z.enum(TRAINING_GOALS);
export const TrainingTypeSchema = z.enum(TRAINING_TYPES);
export const ExerciseTrainingTypeSchema = z.enum(EXERCISE_TRAINING_TYPES);
export const MAX_CUSTOM_GOAL_LENGTH = 200;
export const AllowedTrainingTypesSchema = z.array(ExerciseTrainingTypeSchema).min(1).max(EXERCISE_TRAINING_TYPES.length)
  .refine((values) => new Set(values).size === values.length, "training types must be unique");

export const UserTrainingProfileSchema = z
  .strictObject({
    goal: TrainingGoalSchema,
    customGoal: z.string().min(1).max(MAX_CUSTOM_GOAL_LENGTH).nullable(),
    allowedTrainingTypes: AllowedTrainingTypesSchema
  })
  .superRefine((profile, context) => {
    if (profile.goal !== "OTHER" && profile.customGoal !== null) {
      context.addIssue({ code: "custom", path: ["customGoal"], message: "custom goal is only allowed for OTHER" });
    }
  });

export type TrainingGoal = z.infer<typeof TrainingGoalSchema>;
export type TrainingType = z.infer<typeof TrainingTypeSchema>;
export type ExerciseTrainingType = z.infer<typeof ExerciseTrainingTypeSchema>;
export type UserTrainingProfile = z.infer<typeof UserTrainingProfileSchema>;
