import { z } from "zod";

import { DataSourceSchema, LocalDateSchema, MissingReasonSchema } from "./observation.js";
import { EvidenceMetricSchema, MetricObservationSchema } from "./metrics.js";

export const MissingEvidenceSchema = z.strictObject({
  id: z.string().regex(/^missing_[a-f0-9]{64}$/), kind: z.literal("missing"), metric: EvidenceMetricSchema,
  date: LocalDateSchema.nullable(), reason: MissingReasonSchema, source: DataSourceSchema
});
export const EvidenceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("observation"), observation: MetricObservationSchema }), MissingEvidenceSchema
]);
export type MissingEvidence = z.infer<typeof MissingEvidenceSchema>;
export type Evidence = z.infer<typeof EvidenceSchema>;
