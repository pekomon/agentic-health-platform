import { z } from "zod";

import { CurrentContextSchema } from "./context.js";
import { RecoveryDaySchema, SleepDaySchema, TrainingDaySchema, dayObservations } from "./history.js";
import { InstantSchema, type ValidationIssue } from "./observation.js";
import { UserTrainingProfileSchema } from "./profile.js";
import { MAX_HISTORY_DAYS, makeHistoryWindow, addCalendarDays } from "./time.js";

const SCENARIO_IDS = ["well_recovered_runner", "poor_sleep_low_recovery", "strength_goal_good_recovery", "late_evening_low_recovery", "missing_data"] as const;

export const SyntheticFixtureSchema = z.strictObject({
  schemaVersion: z.literal(1), synthetic: z.literal(true), scenarioId: z.enum(SCENARIO_IDS), clock: InstantSchema,
  profile: UserTrainingProfileSchema, context: CurrentContextSchema,
  sleep: z.array(SleepDaySchema).length(MAX_HISTORY_DAYS),
  recovery: z.array(RecoveryDaySchema).length(MAX_HISTORY_DAYS),
  training: z.array(TrainingDaySchema).length(MAX_HISTORY_DAYS)
}).superRefine((fixture, context) => {
  if (!CurrentContextSchema.safeParse(fixture.context).success || !InstantSchema.safeParse(fixture.clock).success) return;
  if (Date.parse(fixture.clock) !== Date.parse(fixture.context.localTime)) context.addIssue({ code: "custom", path: ["clock"], message: "fixture clock must equal context instant" });
  const dateParts = new Intl.DateTimeFormat("en-CA", { timeZone: fixture.context.timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(Date.parse(fixture.clock)));
  const part = (type: string) => dateParts.find((value) => value.type === type)?.value;
  const endDate = `${part("year")}-${part("month")}-${part("day")}`;
  let window;
  try {
    window = makeHistoryWindow(endDate, MAX_HISTORY_DAYS);
  } catch {
    context.addIssue({ code: "custom", path: ["clock"], message: "fixture clock must support a complete history window" });
    return;
  }
  for (const [name, days] of [["sleep", fixture.sleep], ["recovery", fixture.recovery], ["training", fixture.training]] as const) {
    const dates = days.map((day) => day.date);
    if (dates.some((date, index) => date !== addCalendarDays(window.startDate, index))) {
      context.addIssue({ code: "custom", path: [name], message: "fixture dates must be unique and ascending" });
    }
    if (dates[0] !== window.startDate || dates.at(-1) !== window.endDate) context.addIssue({ code: "custom", path: [name], message: "fixture must cover the 14-day window" });
  }
  const observations = [...fixture.sleep, ...fixture.recovery, ...fixture.training].flatMap(dayObservations);
  const sources = observations.map((observation) => observation.source);
  if (sources.some((source) => source.kind !== "synthetic" || source.channel !== "fixture" || source.datasetId !== fixture.scenarioId)) {
    context.addIssue({ code: "custom", message: "fixture observations must use matching synthetic provenance" });
  }
  if (observations.some((observation) => observation.sourceRecordId === null)) context.addIssue({ code: "custom", message: "fixture observations require record identity" });
  const sessions = fixture.training.flatMap((day) => day.sessions);
  if (new Set(sessions.map((session) => session.id)).size !== sessions.length) context.addIssue({ code: "custom", message: "fixture session IDs must be unique" });
  const ids = observations.map((observation) => observation.id);
  if (new Set(ids).size !== ids.length) context.addIssue({ code: "custom", message: "fixture observation IDs must be unique" });
});

export type SyntheticFixture = z.infer<typeof SyntheticFixtureSchema>;
export type FixtureValidationResult = { ok: true; value: SyntheticFixture } | { ok: false; issues: ValidationIssue[] };

export function validateFixture(input: unknown): FixtureValidationResult {
  const parsed = SyntheticFixtureSchema.safeParse(input);
  if (parsed.success) return { ok: true, value: parsed.data };
  return { ok: false, issues: parsed.error.issues.map((issue) => ({ path: issue.path.length === 0 ? "$" : issue.path.map(String).join("."), code: issue.code })) };
}
