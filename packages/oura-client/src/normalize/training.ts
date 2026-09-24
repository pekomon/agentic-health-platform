import {
  InstantSchema,
  TrainingHistoryResultSchema,
  type DataIssue,
  type HistoryWindow,
  type Instant,
  type LocalDate,
  type MissingReason,
  type TrainingDay,
  type TrainingSession
} from "@ahp/health-domain";

import type { ProviderCollection, WorkoutDto } from "../transport/types.js";
import {
  OURA_REST_SOURCE,
  collectionFailureReason,
  deduplicateById,
  fieldIssueDays,
  issueSortAndDedupe,
  observationId,
  ordinalCompare,
  validateInputs,
  windowDates
} from "./common.js";

const WORKOUT_FIELDS = new Set(["record", "id", "day", "start_datetime", "end_datetime", "activity"]);
const ACTIVITIES: Record<string, "RUNNING" | "WALKING" | "CYCLING" | "STRENGTH"> = {
  running: "RUNNING",
  walking: "WALKING",
  cycling: "CYCLING",
  strength_training: "STRENGTH"
};

function session(record: WorkoutDto): TrainingSession | null {
  if (!InstantSchema.safeParse(record.startDatetime).success || !InstantSchema.safeParse(record.endDatetime).success) return null;
  const elapsedSeconds = (Date.parse(record.endDatetime) - Date.parse(record.startDatetime)) / 1000;
  if (!Number.isFinite(elapsedSeconds) || elapsedSeconds <= 0) return null;
  const period = { start: record.startDatetime, end: record.endDatetime };
  const activity = ACTIVITIES[record.activity] ?? "UNKNOWN";
  return {
    id: record.id,
    date: record.day,
    start: record.startDatetime,
    end: record.endDatetime,
    activity: {
      status: "available",
      observation: {
        id: observationId(record.id, "training.activity", record.day, "training.activity"),
        metric: "training.activity",
        value: activity,
        unit: null,
        source: OURA_REST_SOURCE,
        effectiveDate: record.day,
        period,
        recordedAt: record.endDatetime,
        sourceRecordId: record.id,
        sourceField: "training.activity",
        derivation: null
      }
    },
    duration: {
      status: "available",
      observation: {
        id: observationId(record.id, "training.duration", record.day, "training.duration"),
        metric: "training.duration",
        value: elapsedSeconds,
        unit: "seconds",
        source: OURA_REST_SOURCE,
        effectiveDate: record.day,
        period,
        recordedAt: record.endDatetime,
        sourceRecordId: record.id,
        sourceField: "training.duration",
        derivation: { method: "elapsed_seconds", inputFields: ["start", "end"] }
      }
    }
  };
}

export function normalizeTraining(
  collection: ProviderCollection<WorkoutDto>,
  window: HistoryWindow,
  asOf: Instant
) {
  validateInputs(window, asOf);
  const deduplicated = deduplicateById(collection.records, window);
  const fieldIssues = fieldIssueDays(collection.fieldIssues, window, WORKOUT_FIELDS, collection.records);
  for (const day of deduplicated.conflictDays) fieldIssues.days.add(day);
  const recordsByDay = new Map<LocalDate, WorkoutDto[]>();
  for (const record of deduplicated.records) {
    if (record.day < window.startDate || record.day > window.endDate) continue;
    const records = recordsByDay.get(record.day) ?? [];
    records.push(record);
    recordsByDay.set(record.day, records);
  }
  const transportReason = collectionFailureReason(collection);
  const issues: DataIssue[] = [];

  const days: TrainingDay[] = windowDates(window).map((date) => {
    const records = recordsByDay.get(date) ?? [];
    const sessions = records.map(session);
    const invalid = fieldIssues.unknown || fieldIssues.days.has(date) || sessions.some((value) => value === null);
    if (invalid) {
      issues.push({ code: "invalid_provider_data", date, metric: "training.sessions" });
      return { date, status: "unavailable", sessions: [], reason: "invalid_provider_data" };
    }
    const validSessions = sessions.filter((value): value is TrainingSession => value !== null)
      .sort((left, right) => Date.parse(left.start) - Date.parse(right.start) || ordinalCompare(left.id, right.id));
    if (transportReason !== null) {
      issues.push({ code: transportReason, date, metric: "training.sessions" });
      return {
        date,
        status: validSessions.length === 0 ? "unavailable" : "partial",
        sessions: validSessions,
        reason: transportReason
      };
    }
    return { date, status: "complete", sessions: validSessions, reason: null };
  });

  const normalizedIssues = issueSortAndDedupe(issues);
  const status = days.every((day) => day.status === "complete")
    ? "complete"
    : days.every((day) => day.status === "unavailable")
      ? "unavailable"
      : "partial";
  return TrainingHistoryResultSchema.parse({ schemaVersion: 1, window, asOf, status, days, issues: normalizedIssues });
}
