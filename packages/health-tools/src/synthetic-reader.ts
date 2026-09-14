import { createHash } from "node:crypto";

import {
  CurrentContextResultSchema,
  SyntheticFixtureSchema,
  UserProfileResultSchema,
  addCalendarDays,
  makeHistoryWindow,
  type CurrentContextResult,
  type DataIssue,
  type DataSource,
  type Evidence,
  type HistoryResult,
  type Metric,
  type MetricObservation,
  type MissingEvidence,
  type MissingReason,
  type RecoveryDay,
  type SleepDay,
  type SyntheticFixture,
  type TrainingDay,
  type TrainingSession,
  type UserProfileResult
} from "@ahp/health-domain";

import {
  DEFAULT_HISTORY_DAYS,
  MAX_TRAINING_SESSIONS_PER_WINDOW,
  RecoveryHistoryToolResultSchema,
  SleepHistoryToolResultSchema,
  TrainingHistoryToolResultSchema,
  type HistoryToolInput,
  type RecoveryHistoryToolResult,
  type SemanticHealthReaders,
  type SleepHistoryToolResult,
  type TrainingHistoryToolResult
} from "./contracts.js";

const PROFILE_METRICS = ["profile.goal", "profile.custom_goal", "profile.allowed_training_types"] as const;
const CONTEXT_METRICS = ["context.local_time", "context.bedtime", "context.available_minutes"] as const;
const FAILURE_CODES: readonly MissingReason[] = [
  "permission_denied",
  "authentication_required",
  "provider_unavailable",
  "invalid_provider_data",
  "truncated"
];

type Day = SleepDay | RecoveryDay | TrainingDay;
type HistoryKind = "sleep" | "recovery" | "training";

function digest(value: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function observationId(source: DataSource, sourceRecordId: string | null, metric: Metric, effectiveDate: string, sourceField: string): string {
  return `obs_${digest([source.kind, source.channel, source.datasetId, sourceRecordId, metric, effectiveDate, sourceField])}`;
}

function missingId(source: DataSource, metric: Metric | "training.sessions", date: string | null, reason: MissingReason): string {
  return `missing_${digest([source.kind, source.channel, source.datasetId, metric, date, reason])}`;
}

function localDateFromFixture(fixture: SyntheticFixture): string {
  return fixture.context.localTime.slice(0, 10);
}

function sourceForFixture(fixture: SyntheticFixture): DataSource {
  return { kind: "synthetic", channel: "fixture", datasetId: fixture.scenarioId };
}

function makeInputObservation<T>(fixture: SyntheticFixture, metric: Metric, value: T): MetricObservation {
  const source = sourceForFixture(fixture);
  const effectiveDate = localDateFromFixture(fixture);
  return {
    id: observationId(source, metric, metric, effectiveDate, metric),
    metric,
    value,
    unit: metric === "context.available_minutes" ? "minutes" : null,
    source,
    effectiveDate,
    period: null,
    recordedAt: fixture.context.localTime,
    sourceRecordId: metric,
    sourceField: metric,
    derivation: null
  } as MetricObservation;
}

function makeMissing(fixture: SyntheticFixture, metric: Metric | "training.sessions", date: string | null, reason: MissingReason): MissingEvidence {
  const source = sourceForFixture(fixture);
  return {
    id: missingId(source, metric, date, reason),
    kind: "missing",
    metric,
    date,
    reason,
    source
  };
}

function uniqueIssues(issues: DataIssue[]): DataIssue[] {
  const byKey = new Map<string, DataIssue>();
  for (const issue of issues) byKey.set(`${issue.date ?? ""}\u0000${issue.metric ?? ""}\u0000${issue.code}`, issue);
  return [...byKey.values()].sort((left, right) =>
    `${left.date ?? ""}\u0000${left.metric ?? ""}\u0000${left.code}`.localeCompare(`${right.date ?? ""}\u0000${right.metric ?? ""}\u0000${right.code}`)
  );
}

function uniqueMissing(entries: MissingEvidence[]): MissingEvidence[] {
  const byId = new Map<string, MissingEvidence>();
  for (const entry of entries) {
    const existing = byId.get(entry.id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("CONFLICTING_EVIDENCE");
    byId.set(entry.id, entry);
  }
  return [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
}

function dayObservations(day: Day): MetricObservation[] {
  if ("duration" in day) return day.duration.status === "available" ? [day.duration.observation] : [];
  if ("readiness" in day) return [day.readiness, day.lowestSleepHeartRate].flatMap((state) => state.status === "available" ? [state.observation] : []);
  return day.sessions.flatMap((session) => [session.activity, session.duration].flatMap((state) => state.status === "available" ? [state.observation] : []));
}

function issuesForDay(day: Day): DataIssue[] {
  if ("duration" in day) return day.duration.status === "missing" ? [{ code: day.duration.reason, date: day.date, metric: "sleep.duration" }] : [];
  if ("readiness" in day) return [
    ...(day.readiness.status === "missing" ? [{ code: day.readiness.reason, date: day.date, metric: "oura.readiness_score" as const }] : []),
    ...(day.lowestSleepHeartRate.status === "missing" ? [{ code: day.lowestSleepHeartRate.reason, date: day.date, metric: "oura.sleep_lowest_heart_rate" as const }] : [])
  ];
  return [
    ...(day.reason === null ? [] : [{ code: day.reason, date: day.date, metric: "training.sessions" as const }]),
    ...day.sessions.flatMap((session) => [
      ...(session.activity.status === "missing" ? [{ code: session.activity.reason, date: day.date, metric: "training.activity" as const }] : []),
      ...(session.duration.status === "missing" ? [{ code: session.duration.reason, date: day.date, metric: "training.duration" as const }] : [])
    ])
  ];
}

function missingForDay(fixture: SyntheticFixture, day: Day): MissingEvidence[] {
  if ("duration" in day) return day.duration.status === "missing" ? [makeMissing(fixture, "sleep.duration", day.date, day.duration.reason)] : [];
  if ("readiness" in day) return [
    ...(day.readiness.status === "missing" ? [makeMissing(fixture, "oura.readiness_score", day.date, day.readiness.reason)] : []),
    ...(day.lowestSleepHeartRate.status === "missing" ? [makeMissing(fixture, "oura.sleep_lowest_heart_rate", day.date, day.lowestSleepHeartRate.reason)] : [])
  ];
  return [
    ...(day.reason === null ? [] : [makeMissing(fixture, "training.sessions", day.date, day.reason)]),
    ...day.sessions.flatMap((session) => [
      ...(session.activity.status === "missing" ? [makeMissing(fixture, "training.activity", day.date, session.activity.reason)] : []),
      ...(session.duration.status === "missing" ? [makeMissing(fixture, "training.duration", day.date, session.duration.reason)] : [])
    ])
  ];
}

function statusFor(kind: HistoryKind, days: Day[], issues: DataIssue[]): "complete" | "partial" | "unavailable" {
  if (kind === "training") {
    const trainingDays = days as TrainingDay[];
    if (trainingDays.every((day) => day.status === "unavailable")) return "unavailable";
    if (trainingDays.every((day) => day.status === "complete") && !issues.some((issue) => issue.metric === "training.sessions" || issue.metric === null || FAILURE_CODES.includes(issue.code))) return "complete";
    return "partial";
  }
  const observations = days.flatMap(dayObservations);
  if (observations.length === 0) return "unavailable";
  if (issues.length === 0) return "complete";
  return "partial";
}

function trimTraining(days: TrainingDay[], fixture: SyntheticFixture): { days: TrainingDay[]; missing: MissingEvidence[]; issues: DataIssue[] } {
  const sessions = days.flatMap((day) => day.sessions.map((session) => ({ day, session })));
  if (sessions.length <= MAX_TRAINING_SESSIONS_PER_WINDOW) return { days, missing: [], issues: [] };

  const retainedIds = new Set(
    sessions
      .sort((left, right) => Date.parse(right.session.start) - Date.parse(left.session.start) || right.session.id.localeCompare(left.session.id))
      .slice(0, MAX_TRAINING_SESSIONS_PER_WINDOW)
      .map(({ session }) => session.id)
  );

  const missing: MissingEvidence[] = [];
  const issues: DataIssue[] = [];
  const trimmedDays = days.map((day) => {
    const retained = day.sessions.filter((session) => retainedIds.has(session.id));
    if (retained.length === day.sessions.length) return day;
    missing.push(makeMissing(fixture, "training.sessions", day.date, "truncated"));
    issues.push({ code: "truncated", date: day.date, metric: "training.sessions" });
    return {
      ...day,
      sessions: retained,
      status: retained.length === 0 ? "unavailable" as const : "partial" as const,
      // Preserve a reason that establishes missing coverage. Truncation remains
      // explicit in the top-level issue and missing evidence above.
      reason: day.reason ?? "truncated" as const
    };
  });
  return { days: trimmedDays, missing, issues };
}

function historyFor<TDay extends Day, TResult extends HistoryResult<TDay> & { missing: MissingEvidence[] }>(
  fixture: SyntheticFixture,
  kind: HistoryKind,
  allDays: TDay[],
  input: HistoryToolInput | undefined,
  parse: (value: unknown) => TResult
): TResult {
  const daysRequested = input?.days ?? DEFAULT_HISTORY_DAYS;
  const endDate = localDateFromFixture(fixture);
  const window = makeHistoryWindow(endDate, daysRequested);
  const days = allDays.filter((day) => day.date >= window.startDate && day.date <= window.endDate);
  let extraMissing: MissingEvidence[] = [];
  let extraIssues: DataIssue[] = [];
  let retainedDays: Day[] = days;

  if (kind === "training") {
    const trimmed = trimTraining(days as TrainingDay[], fixture);
    retainedDays = trimmed.days;
    extraMissing = trimmed.missing;
    extraIssues = trimmed.issues;
  }

  const issues = uniqueIssues([...retainedDays.flatMap(issuesForDay), ...extraIssues]);
  const result = {
    schemaVersion: 1,
    window,
    asOf: fixture.clock,
    status: statusFor(kind, retainedDays, issues),
    days: retainedDays,
    issues,
    missing: uniqueMissing([...retainedDays.flatMap((day) => missingForDay(fixture, day)), ...extraMissing])
  };
  return parse(result);
}

function assertNoConflictingEvidence(result: { observations: MetricObservation[]; missing: MissingEvidence[] } | { days: Day[]; missing: MissingEvidence[] }): void {
  const observations = "observations" in result ? result.observations : result.days.flatMap(dayObservations);
  const evidence = [...observations.map((observation): Evidence => ({ kind: "observation", observation })), ...result.missing];
  const byId = new Map<string, Evidence>();
  for (const entry of evidence) {
    const id = entry.kind === "observation" ? entry.observation.id : entry.id;
    const existing = byId.get(id);
    if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(entry)) throw new Error("CONFLICTING_EVIDENCE");
    byId.set(id, entry);
  }
}

export function createSyntheticHealthTools(input: SyntheticFixture): SemanticHealthReaders {
  const fixture = SyntheticFixtureSchema.parse(input);

  return {
    get_user_profile() {
      const observations = [
        makeInputObservation(fixture, "profile.goal", fixture.profile.goal),
        makeInputObservation(fixture, "profile.allowed_training_types", fixture.profile.allowedTrainingTypes)
      ];
      const missing = fixture.profile.customGoal === null
        ? [makeMissing(fixture, "profile.custom_goal", null, "not_provided")]
        : [];
      if (fixture.profile.customGoal !== null) observations.splice(1, 0, makeInputObservation(fixture, "profile.custom_goal", fixture.profile.customGoal));
      const result = UserProfileResultSchema.parse({ schemaVersion: 1, profile: fixture.profile, observations, missing });
      assertNoConflictingEvidence(result);
      return result;
    },

    get_current_context() {
      const observations = [makeInputObservation(fixture, "context.local_time", fixture.context.localTime)];
      const missing: MissingEvidence[] = [];
      if (fixture.context.bedtime === null) missing.push(makeMissing(fixture, "context.bedtime", null, "not_provided"));
      else observations.push(makeInputObservation(fixture, "context.bedtime", fixture.context.bedtime));
      if (fixture.context.availableMinutes === null) missing.push(makeMissing(fixture, "context.available_minutes", null, "not_provided"));
      else observations.push(makeInputObservation(fixture, "context.available_minutes", fixture.context.availableMinutes));
      const result = CurrentContextResultSchema.parse({ schemaVersion: 1, context: fixture.context, observations, missing });
      assertNoConflictingEvidence(result);
      return result;
    },

    get_sleep_history(input) {
      const result = historyFor(fixture, "sleep", fixture.sleep, input, (value) => SleepHistoryToolResultSchema.parse(value));
      assertNoConflictingEvidence(result);
      return result;
    },

    get_recovery_history(input) {
      const result = historyFor(fixture, "recovery", fixture.recovery, input, (value) => RecoveryHistoryToolResultSchema.parse(value));
      assertNoConflictingEvidence(result);
      return result;
    },

    get_recent_training(input) {
      const result = historyFor(fixture, "training", fixture.training, input, (value) => TrainingHistoryToolResultSchema.parse(value));
      assertNoConflictingEvidence(result);
      return result;
    }
  };
}

export function expectedFixtureDates(fixture: SyntheticFixture, days = DEFAULT_HISTORY_DAYS): string[] {
  const window = makeHistoryWindow(localDateFromFixture(fixture), days);
  return Array.from({ length: days }, (_, index) => addCalendarDays(window.startDate, index));
}

export const _test = {
  observationId,
  missingId,
  makeMissing,
  PROFILE_METRICS,
  CONTEXT_METRICS
};
