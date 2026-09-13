import { z } from "zod";

const DATASET_ID_MAX_LENGTH = 64;
const SOURCE_RECORD_ID_MAX_LENGTH = 256;
const SOURCE_FIELD_MAX_LENGTH = 128;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{64}$/;
const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INSTANT_PATTERN =
  /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const SOURCE_FIELD_ALLOWLIST = [
  "sleep.duration", "oura.readiness_score", "oura.sleep_lowest_heart_rate",
  "training.activity", "training.duration", "profile.goal", "profile.custom_goal",
  "profile.allowed_training_types", "context.local_time", "context.bedtime", "context.available_minutes"
] as const;

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) {
    return isLeapYear(year) ? 29 : 28;
  }

  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function isRealLocalDate(value: string): boolean {
  const match = LOCAL_DATE_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);

  return (
    Number.isInteger(year) &&
    year >= 1 &&
    month >= 1 &&
    month <= 12 &&
    day >= 1 &&
    day <= daysInMonth(year, month)
  );
}

function isValidOffset(offset: string): boolean {
  if (offset === "Z") {
    return true;
  }

  const hours = Number(offset.slice(1, 3));
  const minutes = Number(offset.slice(4, 6));
  return hours <= 23 && minutes <= 59;
}

function isValidInstant(value: string): boolean {
  const match = INSTANT_PATTERN.exec(value);
  if (match === null) {
    return false;
  }

  const date = match[1];
  const hourText = match[2];
  const minuteText = match[3];
  const secondText = match[4];
  const offset = match[5];
  if (
    date === undefined ||
    hourText === undefined ||
    minuteText === undefined ||
    secondText === undefined ||
    offset === undefined
  ) {
    return false;
  }

  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  return (
    isRealLocalDate(date) &&
    hour <= 23 &&
    minute <= 59 &&
    second <= 59 &&
    isValidOffset(offset) &&
    Number.isFinite(Date.parse(value))
  );
}

function instantEpochMilliseconds(value: string): number {
  return Date.parse(value);
}

function pathToString(path: PropertyKey[]): string {
  return path.length === 0 ? "$" : path.map(String).join(".");
}

export const LocalDateSchema = z
  .string()
  .regex(LOCAL_DATE_PATTERN)
  .refine(isRealLocalDate);

export const InstantSchema = z
  .string()
  .regex(INSTANT_PATTERN)
  .refine(isValidInstant);

export const DataSourceSchema = z
  .strictObject({
    kind: z.enum(["synthetic", "user", "oura"]),
    channel: z.enum(["fixture", "input", "rest", "mcp"]),
    datasetId: z.string().min(1).max(DATASET_ID_MAX_LENGTH).nullable()
  })
  .superRefine((source, context) => {
    const validSynthetic =
      source.kind === "synthetic" &&
      source.channel === "fixture" &&
      source.datasetId !== null;
    const validUser =
      source.kind === "user" &&
      source.channel === "input" &&
      source.datasetId === null;
    const validOura =
      source.kind === "oura" &&
      (source.channel === "rest" || source.channel === "mcp") &&
      source.datasetId === null;

    if (!validSynthetic && !validUser && !validOura) {
      context.addIssue({
        code: "custom",
        path: ["channel"],
        message: "invalid source kind/channel/dataset pairing"
      });
    }
  });

const PeriodSchema = z
  .strictObject({
    start: InstantSchema,
    end: InstantSchema
  })
  .superRefine((period, context) => {
    if (
      instantEpochMilliseconds(period.start) > instantEpochMilliseconds(period.end)
    ) {
      context.addIssue({
        code: "custom",
        path: ["end"],
        message: "period end must not precede start"
      });
    }
  });

const DerivationSchema = z.strictObject({
  method: z.literal("elapsed_seconds"),
  inputFields: z
    .array(z.string().min(1).max(SOURCE_FIELD_MAX_LENGTH))
    .min(1)
    .max(8)
});

export const ObservationFieldsSchema = z.strictObject({
    id: z.string().regex(OBSERVATION_ID_PATTERN),
    source: DataSourceSchema,
    effectiveDate: LocalDateSchema,
    period: PeriodSchema.nullable(),
    recordedAt: InstantSchema.nullable(),
    sourceRecordId: z
      .string()
      .min(1)
      .max(SOURCE_RECORD_ID_MAX_LENGTH)
      .nullable(),
});

export const SleepDurationObservationSchema = ObservationFieldsSchema
  .extend({
    metric: z.literal("sleep.duration"),
    value: z.number().finite().int().min(0),
    unit: z.literal("seconds"),
    sourceField: z.literal("sleep.duration"),
    derivation: DerivationSchema.nullable()
  })
  .superRefine((observation, context) => {
    if (observation.period === null) {
      return;
    }

    const elapsedSeconds =
      (instantEpochMilliseconds(observation.period.end) -
        instantEpochMilliseconds(observation.period.start)) /
      1000;

    if (observation.value > elapsedSeconds) {
      context.addIssue({
        code: "custom",
        path: ["value"],
        message: "duration must not exceed observation period"
      });
    }
  });

export const MissingReasonSchema = z.enum([
  "not_recorded",
  "not_provided",
  "permission_denied",
  "authentication_required",
  "provider_unavailable",
  "invalid_provider_data",
  "unsupported",
  "truncated"
]);

const AvailableSleepDurationStateSchema = z.strictObject({
  status: z.literal("available"),
  observation: SleepDurationObservationSchema
});

const MissingSleepDurationStateSchema = z.strictObject({
  status: z.literal("missing"),
  reason: MissingReasonSchema
});

export const SleepDurationStateSchema = z.discriminatedUnion("status", [
  AvailableSleepDurationStateSchema,
  MissingSleepDurationStateSchema
]);

export function createMetricStateSchema<T extends z.ZodType>(observation: T) {
  return z.discriminatedUnion("status", [
    z.strictObject({ status: z.literal("available"), observation }),
    z.strictObject({ status: z.literal("missing"), reason: MissingReasonSchema })
  ]);
}

export type LocalDate = z.infer<typeof LocalDateSchema>;
export type Instant = z.infer<typeof InstantSchema>;
export type DataSource = z.infer<typeof DataSourceSchema>;
export type MissingReason = z.infer<typeof MissingReasonSchema>;
export type SleepDurationObservation = z.infer<
  typeof SleepDurationObservationSchema
>;
export type Observation<T> = {
  id: string;
  metric: string;
  value: T;
  unit: string | null;
  source: DataSource;
  effectiveDate: LocalDate;
  period: { start: Instant; end: Instant } | null;
  recordedAt: Instant | null;
  sourceRecordId: string | null;
  sourceField: string;
  derivation: {
    method: "elapsed_seconds";
    inputFields: string[];
  } | null;
};
export type SleepDurationState = z.infer<typeof SleepDurationStateSchema>;
export type MetricState<T> =
  | { status: "available"; observation: Observation<T> }
  | { status: "missing"; reason: MissingReason };
export type ValidationIssue = { path: string; code: string };
export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; issues: ValidationIssue[] };

export function validateSleepDurationState(
  input: unknown
): ValidationResult<SleepDurationState> {
  const parsed = SleepDurationStateSchema.safeParse(input);

  if (parsed.success) {
    return { ok: true, value: parsed.data };
  }

  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: pathToString(issue.path),
      code: issue.code
    }))
  };
}
