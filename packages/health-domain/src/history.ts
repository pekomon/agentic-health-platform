import { z } from "zod";
import { InstantSchema, LocalDateSchema, MissingReasonSchema, SleepDurationStateSchema, createMetricStateSchema, type MetricState } from "./observation.js";
import { EvidenceMetricSchema, LowestSleepHeartRateObservationSchema, ReadinessObservationSchema, TrainingActivityObservationSchema, TrainingDurationObservationSchema } from "./metrics.js";
import { HistoryWindowSchema, addCalendarDays, countCalendarDays } from "./time.js";

export const HistoryStatusSchema = z.enum(["complete", "partial", "unavailable"]);
export const DataIssueSchema = z.strictObject({ code: MissingReasonSchema, date: LocalDateSchema.nullable(), metric: EvidenceMetricSchema.nullable() });
export type DataIssue = z.infer<typeof DataIssueSchema>;

function checkDate(date: string, states: MetricState<unknown>[], context: z.RefinementCtx) {
  for (const state of states) if (state.status === "available" && state.observation.effectiveDate !== date) {
    context.addIssue({ code: "custom", message: "observation date must match enclosing date" });
  }
}
export const SleepDaySchema = z.strictObject({ date: LocalDateSchema, duration: SleepDurationStateSchema })
  .superRefine((day, context) => checkDate(day.date, [day.duration], context));
export const RecoveryDaySchema = z.strictObject({ date: LocalDateSchema, readiness: createMetricStateSchema(ReadinessObservationSchema), lowestSleepHeartRate: createMetricStateSchema(LowestSleepHeartRateObservationSchema) })
  .superRefine((day, context) => checkDate(day.date, [day.readiness, day.lowestSleepHeartRate], context));
export const TrainingSessionSchema = z.strictObject({
  id: z.string().min(1).max(256), date: LocalDateSchema, start: InstantSchema, end: InstantSchema,
  activity: createMetricStateSchema(TrainingActivityObservationSchema), duration: createMetricStateSchema(TrainingDurationObservationSchema)
}).superRefine((session, context) => {
  if (Date.parse(session.start) >= Date.parse(session.end)) context.addIssue({ code: "custom", path: ["end"], message: "training must end after start" });
  checkDate(session.date, [session.activity, session.duration], context);
  const observations = [session.activity, session.duration].flatMap((state) => state.status === "available" ? [state.observation] : []);
  for (const observation of observations) if (observation.sourceRecordId !== session.id || observation.period === null ||
    Date.parse(observation.period.start) !== Date.parse(session.start) || Date.parse(observation.period.end) !== Date.parse(session.end)) {
    context.addIssue({ code: "custom", message: "session observation identity and period must match session" });
  }
  if (observations.length === 2 && JSON.stringify(observations[0]!.source) !== JSON.stringify(observations[1]!.source)) context.addIssue({ code: "custom", message: "session observations must share provenance" });
  if (session.duration.status === "available" && session.duration.observation.value !== (Date.parse(session.end) - Date.parse(session.start)) / 1000) context.addIssue({ code: "custom", message: "training duration must equal elapsed seconds" });
});
export const TrainingDaySchema = z.strictObject({
  date: LocalDateSchema, status: HistoryStatusSchema, sessions: z.array(TrainingSessionSchema), reason: MissingReasonSchema.nullable()
}).superRefine((day, context) => {
  if ((day.status === "complete") !== (day.reason === null)) context.addIssue({ code: "custom", path: ["reason"], message: "training status and reason conflict" });
  if (day.status === "unavailable" && day.sessions.length !== 0) context.addIssue({ code: "custom", path: ["sessions"], message: "unavailable training has no sessions" });
  if (day.status === "partial" && day.sessions.length === 0) context.addIssue({ code: "custom", path: ["sessions"], message: "partial training retains sessions" });
  for (const session of day.sessions) if (session.date !== day.date) context.addIssue({ code: "custom", message: "session date must match enclosing day" });
  for (let i = 1; i < day.sessions.length; i++) {
    const previous = day.sessions[i - 1]!;
    const current = day.sessions[i]!;
    if (Date.parse(previous.start) > Date.parse(current.start) || (Date.parse(previous.start) === Date.parse(current.start) && previous.id >= current.id)) context.addIssue({ code: "custom", message: "sessions must be ordered by start and id" });
  }
});
export type SleepDay = z.infer<typeof SleepDaySchema>;
export type RecoveryDay = z.infer<typeof RecoveryDaySchema>;
export type TrainingSession = z.infer<typeof TrainingSessionSchema>;
export type TrainingDay = z.infer<typeof TrainingDaySchema>;
type Day = SleepDay | RecoveryDay | TrainingDay;

export function dayObservations(day: Day) {
  const states: MetricState<unknown>[] = "duration" in day ? [day.duration] : "readiness" in day ? [day.readiness, day.lowestSleepHeartRate] : day.sessions.flatMap((session) => [session.activity, session.duration]);
  return states.flatMap((state) => state.status === "available" ? [state.observation] : []);
}
function missingIssues(day: Day): DataIssue[] {
  if ("sessions" in day) return [
    ...(day.reason === null ? [] : [{ code: day.reason, date: day.date, metric: "training.sessions" as const }]),
    ...day.sessions.flatMap((session) => [
      ...(session.activity.status === "missing" ? [{ code: session.activity.reason, date: day.date, metric: "training.activity" as const }] : []),
      ...(session.duration.status === "missing" ? [{ code: session.duration.reason, date: day.date, metric: "training.duration" as const }] : [])
    ])
  ];
  const entries: [string, MetricState<unknown>][] = "duration" in day ? [["sleep.duration", day.duration]] : [["oura.readiness_score", day.readiness], ["oura.sleep_lowest_heart_rate", day.lowestSleepHeartRate]];
  return entries.flatMap(([metric, state]) => state.status === "missing" ? [DataIssueSchema.parse({ code: state.reason, date: day.date, metric })] : []);
}
export function dataIssueKey(issue: DataIssue): string { return `${issue.date ?? ""}\u0000${issue.metric ?? ""}\u0000${issue.code}`; }

function historySchema<S extends z.ZodType<Day>>(schema: S, metrics: readonly string[]) {
  return z.strictObject({ schemaVersion: z.literal(1), window: HistoryWindowSchema, asOf: InstantSchema, status: HistoryStatusSchema, days: z.array(schema), issues: z.array(DataIssueSchema) }).superRefine((result, context) => {
    const fail = (message: string) => context.addIssue({ code: "custom", message });
    if (!HistoryWindowSchema.safeParse(result.window).success) return;
    if (result.days.length !== countCalendarDays(result.window.startDate, result.window.endDate) || result.days.some((day, index) => day.date !== addCalendarDays(result.window.startDate, index))) fail("history must contain every window date in ascending order");
    const observations = result.days.flatMap(dayObservations);
    if (new Set(observations.map((observation) => observation.id)).size !== observations.length) fail("observation IDs must be unique");
    const sessions = result.days.flatMap((day) => "sessions" in day ? day.sessions : []);
    if (new Set(sessions.map((session) => session.id)).size !== sessions.length) fail("session IDs must be unique");
    const keys = result.issues.map(dataIssueKey);
    if (keys.some((key, index) => index > 0 && key <= keys[index - 1]!)) fail("issues must be unique and sorted by date, metric, code");
    const requiredIssues = result.days.flatMap(missingIssues);
    for (const issue of result.issues) {
      if (issue.date !== null && (issue.date < result.window.startDate || issue.date > result.window.endDate)) fail("issue date must lie in window");
      if (issue.metric !== null && !metrics.includes(issue.metric)) fail("issue metric must belong to history kind");
      if (issue.date === null && issue.metric !== null) fail("dataset-wide issues have no metric");
      if (["not_recorded", "not_provided", "unsupported"].includes(issue.code) && !requiredIssues.some((required) => dataIssueKey(required) === dataIssueKey(issue))) fail("missing-value issues must describe a missing field or unavailable coverage");
    }
    for (const issue of requiredIssues) if (!keys.includes(dataIssueKey(issue))) fail("missing data must have a matching issue");
    const training = result.days.every((day) => "sessions" in day);
    const unavailable = training ? result.days.every((day) => "sessions" in day && day.status === "unavailable") : observations.length === 0;
    const complete = training ? result.days.every((day) => "sessions" in day && day.status === "complete") : result.days.every((day) => missingIssues(day).length === 0);
    const coverageIssue = result.issues.some((issue) => issue.metric === null || issue.metric === "training.sessions" ||
      ["provider_unavailable", "invalid_provider_data", "permission_denied", "authentication_required", "truncated"].includes(issue.code));
    const expected = unavailable ? "unavailable" : complete && !coverageIssue ? "complete" : "partial";
    if (result.status !== expected) fail("history status must match availability and coverage issues");
  });
}
export const SleepHistoryResultSchema = historySchema(SleepDaySchema, ["sleep.duration"]);
export const RecoveryHistoryResultSchema = historySchema(RecoveryDaySchema, ["oura.readiness_score", "oura.sleep_lowest_heart_rate"]);
export const TrainingHistoryResultSchema = historySchema(TrainingDaySchema, ["training.activity", "training.duration", "training.sessions"]);
export const HistoryResultSchema = z.union([SleepHistoryResultSchema, RecoveryHistoryResultSchema, TrainingHistoryResultSchema]);
export type HistoryResult<T> = { schemaVersion: 1; window: z.infer<typeof HistoryWindowSchema>; asOf: string; status: z.infer<typeof HistoryStatusSchema>; days: T[]; issues: DataIssue[] };
