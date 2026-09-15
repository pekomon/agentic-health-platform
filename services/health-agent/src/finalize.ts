import {
  DailyTrainingRecommendationSchema,
  RecommendationDraftSchema,
  type DailyTrainingRecommendation,
  type Evidence,
  type MissingEvidence,
  type RecommendationDraft
} from "@ahp/health-domain";

import { isMissingEvidence, type LedgerSnapshot } from "./ledger.js";

export const RECOMMENDATION_ERROR_CODES = [
  "INVALID_OUTPUT",
  "UNGROUNDED_EVIDENCE",
  "CONSTRAINT_VIOLATION",
  "CONFLICTING_EVIDENCE",
  "INSUFFICIENT_CONTEXT",
  "MODEL_UNAVAILABLE",
  "MODEL_REFUSAL",
  "RUN_LIMIT",
  "POLICY_BLOCKED"
] as const;

export type RecommendationErrorCode = (typeof RECOMMENDATION_ERROR_CODES)[number];
export type RecommendationError = { code: RecommendationErrorCode };
export type RecommendationResult =
  | { ok: true; value: DailyTrainingRecommendation }
  | { ok: false; error: RecommendationError };

function failure(code: RecommendationErrorCode): RecommendationResult {
  return { ok: false, error: { code } };
}

function availableHealth(snapshot: LedgerSnapshot, metric: "sleep.duration" | "oura.readiness_score"): boolean {
  return [...snapshot.evidence.values()].some((entry) => entry.kind === "observation" && entry.observation.metric === metric);
}

function missingHealth(snapshot: LedgerSnapshot, metric: "sleep.duration" | "oura.readiness_score"): MissingEvidence[] {
  return [...snapshot.evidence.values()].filter((entry): entry is MissingEvidence =>
    isMissingEvidence(entry) && entry.metric === metric
  );
}

function hasExactEvidence(entries: readonly Evidence[], expected: Evidence): boolean {
  return entries.some((entry) => JSON.stringify(entry) === JSON.stringify(expected));
}

export function finalizeRecommendation(draftInput: unknown, snapshot: LedgerSnapshot): RecommendationResult {
  // Reference integrity and constraints are deterministic; they cannot prove
  // that free-form claim wording semantically follows from the cited values.
  // The later model-evaluation slice owns that separate behavioral assessment.
  const parsed = RecommendationDraftSchema.safeParse(draftInput);
  if (!parsed.success) return failure("INVALID_OUTPUT");
  const draft: RecommendationDraft = parsed.data;

  if (snapshot.profile === null || snapshot.context === null ||
    !snapshot.calls.has("get_user_profile") || !snapshot.calls.has("get_current_context")) {
    return failure("INSUFFICIENT_CONTEXT");
  }
  if (!snapshot.calls.has("get_sleep_history") || !snapshot.calls.has("get_recovery_history")) {
    return failure("INSUFFICIENT_CONTEXT");
  }

  const allowed = draft.activity === "REST" || snapshot.profile.profile.allowedTrainingTypes.includes(draft.activity);
  if (!allowed) return failure("CONSTRAINT_VIOLATION");
  const availableMinutes = snapshot.context.context.availableMinutes;
  if (availableMinutes === 0 && draft.activity !== "REST") return failure("CONSTRAINT_VIOLATION");
  if (draft.durationMinutes !== null && availableMinutes !== null && draft.durationMinutes > availableMinutes) {
    return failure("CONSTRAINT_VIOLATION");
  }

  const evidence: Evidence[] = [];
  const cited = new Set<string>();
  for (const claim of draft.rationaleClaims) {
    for (const id of claim.evidenceIds) {
      const entry = snapshot.evidence.get(id);
      if (entry === undefined) return failure("UNGROUNDED_EVIDENCE");
      if (!hasExactEvidence([...snapshot.evidence.values()], entry)) return failure("CONFLICTING_EVIDENCE");
      if (!cited.has(id)) {
        cited.add(id);
        evidence.push(structuredClone(entry));
      }
    }
  }

  if (new Set(draft.limitationIds).size !== draft.limitationIds.length) return failure("INVALID_OUTPUT");
  const limitations: MissingEvidence[] = [];
  for (const id of draft.limitationIds) {
    const entry = snapshot.evidence.get(id);
    if (entry === undefined || !isMissingEvidence(entry)) return failure("UNGROUNDED_EVIDENCE");
    limitations.push(structuredClone(entry));
  }

  const sleepUnavailable = !availableHealth(snapshot, "sleep.duration");
  const recoveryUnavailable = !availableHealth(snapshot, "oura.readiness_score");
  if (sleepUnavailable && !missingHealth(snapshot, "sleep.duration").some((entry) => draft.limitationIds.includes(entry.id))) {
    return failure("INSUFFICIENT_CONTEXT");
  }
  if (recoveryUnavailable && !missingHealth(snapshot, "oura.readiness_score").some((entry) => draft.limitationIds.includes(entry.id))) {
    return failure("INSUFFICIENT_CONTEXT");
  }

  const output = {
    activity: draft.activity,
    intensity: draft.intensity,
    ...(draft.durationMinutes === null ? {} : { durationMinutes: draft.durationMinutes }),
    rationale: draft.rationaleClaims.map((claim) => claim.text).join(" "),
    evidence,
    confidence: draft.confidence,
    limitations,
    claims: draft.rationaleClaims
  };
  const final = DailyTrainingRecommendationSchema.safeParse(output);
  return final.success ? { ok: true, value: final.data } : failure("INVALID_OUTPUT");
}
