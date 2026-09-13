import { z } from "zod";
import { CurrentContextSchema } from "./context.js";
import { MissingEvidenceSchema } from "./evidence.js";
import { MetricObservationSchema, type MetricObservation } from "./metrics.js";
import { UserTrainingProfileSchema } from "./profile.js";

const evidenceFields = { schemaVersion: z.literal(1), observations: z.array(MetricObservationSchema), missing: z.array(MissingEvidenceSchema) };

function validateInputEvidence(
  result: { observations: MetricObservation[]; missing: z.infer<typeof MissingEvidenceSchema>[] },
  expected: Record<string, unknown>, context: z.RefinementCtx
) {
  const fail = (message: string) => context.addIssue({ code: "custom", message });
  const metrics = [...result.observations.map((observation) => observation.metric), ...result.missing.map((entry) => entry.metric)];
  if (metrics.length !== Object.keys(expected).length || new Set(metrics).size !== metrics.length || metrics.some((metric) => !(metric in expected))) fail("exactly one evidence entry is required per input field");
  for (const observation of result.observations) {
    if (expected[observation.metric] === null || JSON.stringify(observation.value) !== JSON.stringify(expected[observation.metric])) fail("observation must equal typed input");
    if (observation.sourceRecordId !== observation.metric || observation.period !== null || observation.recordedAt === null) fail("input observation must use field identity and recording time");
  }
  for (const entry of result.missing) if (expected[entry.metric] !== null || entry.reason !== "not_provided" || entry.date !== null) fail("missing optional input must be not_provided with no date");
  const sources = [...result.observations.map((observation) => observation.source), ...result.missing.map((entry) => entry.source)];
  if (sources.some((source) => source.kind !== "user" && source.kind !== "synthetic") || sources.some((source) => JSON.stringify(source) !== JSON.stringify(sources[0]))) fail("input evidence must share user/input or synthetic/fixture provenance");
  if (new Set(result.observations.map((observation) => observation.id)).size !== result.observations.length || new Set(result.missing.map((entry) => entry.id)).size !== result.missing.length) fail("input evidence IDs must be unique");
  if (new Set(result.observations.map((observation) => observation.effectiveDate)).size > 1 || new Set(result.observations.map((observation) => observation.recordedAt)).size > 1) fail("input observations must share a frozen date and recording time");
}

export const UserProfileResultSchema = z.strictObject({ ...evidenceFields, profile: UserTrainingProfileSchema }).superRefine((result, context) => {
  validateInputEvidence(result, { "profile.goal": result.profile.goal, "profile.custom_goal": result.profile.customGoal, "profile.allowed_training_types": result.profile.allowedTrainingTypes }, context);
});
export const CurrentContextResultSchema = z.strictObject({ ...evidenceFields, context: CurrentContextSchema }).superRefine((result, context) => {
  validateInputEvidence(result, { "context.local_time": result.context.localTime, "context.bedtime": result.context.bedtime, "context.available_minutes": result.context.availableMinutes }, context);
  if (!CurrentContextSchema.safeParse(result.context).success) return;
  // Explicit offset consistency is already validated, so the local date is authoritative here.
  const date = result.context.localTime.slice(0, 10);
  for (const observation of result.observations) if (observation.effectiveDate !== date || Date.parse(observation.recordedAt ?? "") !== Date.parse(result.context.localTime)) context.addIssue({ code: "custom", message: "context evidence must use the frozen context date and instant" });
});
export type UserProfileResult = z.infer<typeof UserProfileResultSchema>;
export type CurrentContextResult = z.infer<typeof CurrentContextResultSchema>;
