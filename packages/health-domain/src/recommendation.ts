import { z } from "zod";

import { EvidenceSchema, MissingEvidenceSchema } from "./evidence.js";
import { TrainingTypeSchema } from "./profile.js";

export const MAX_RECOMMENDED_MINUTES = 180;
export const RecommendationClaimSchema = z.strictObject({ text: z.string().min(1).max(300), evidenceIds: z.array(z.string().min(1)).min(1).max(8).superRefine((ids, context) => { if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "evidence IDs must be unique" }); }) });
export const RecommendationDraftSchema = z.strictObject({
  activity: TrainingTypeSchema, intensity: z.enum(["REST", "EASY", "MODERATE", "HARD"]), durationMinutes: z.number().int().min(1).max(MAX_RECOMMENDED_MINUTES).nullable(), targetHeartRateZone: z.null(), rationaleClaims: z.array(RecommendationClaimSchema).min(1).max(6), confidence: z.number().finite().min(0).max(1), limitationIds: z.array(z.string().min(1)).max(20)
}).superRefine((draft, context) => {
  const ids = draft.rationaleClaims.flatMap((claim) => claim.evidenceIds);
  if (new Set(ids).size > 20) context.addIssue({ code: "custom", path: ["rationaleClaims"], message: "too many evidence IDs" });
  if ((draft.activity === "REST") !== (draft.intensity === "REST")) context.addIssue({ code: "custom", path: ["intensity"], message: "rest activity and intensity must match" });
  if (draft.activity === "REST" && draft.durationMinutes !== null) context.addIssue({ code: "custom", path: ["durationMinutes"], message: "rest has no duration" });
  if (draft.activity !== "REST" && draft.durationMinutes === null) context.addIssue({ code: "custom", path: ["durationMinutes"], message: "active recommendation needs duration" });
});
export const DailyTrainingRecommendationSchema = z.strictObject({ activity: TrainingTypeSchema, intensity: z.enum(["REST", "EASY", "MODERATE", "HARD"]), durationMinutes: z.number().int().min(1).max(MAX_RECOMMENDED_MINUTES).optional(), rationale: z.string().min(1), evidence: z.array(EvidenceSchema), confidence: z.number().finite().min(0).max(1), limitations: z.array(MissingEvidenceSchema), claims: z.array(RecommendationClaimSchema) });
export type RecommendationDraft = z.infer<typeof RecommendationDraftSchema>;
export type DailyTrainingRecommendation = z.infer<typeof DailyTrainingRecommendationSchema>;
