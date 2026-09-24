import { createHash } from "node:crypto";
import {
  HistoryWindowSchema,
  InstantSchema,
  addCalendarDays,
  countCalendarDays,
  type DataIssue,
  type HistoryWindow,
  type LocalDate,
  type MissingReason
} from "@ahp/health-domain";

import type {
  ProviderCollection,
  ProviderFailure,
  ProviderFieldIssue,
  SleepDto
} from "../transport/types.js";

export const OURA_REST_SOURCE = {
  kind: "oura",
  channel: "rest",
  datasetId: null
} as const;

const RECOGNIZED_SLEEP_TYPES = new Set(["deleted", "sleep", "long_sleep", "late_nap", "rest"]);

export function ordinalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameFlatRecord(left: object, right: object): boolean {
  const leftValues = left as Record<string, unknown>;
  const rightValues = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftValues);
  if (leftKeys.length !== Object.keys(rightValues).length) return false;
  return leftKeys.every((key) =>
    Object.hasOwn(rightValues, key) && Object.is(leftValues[key], rightValues[key])
  );
}

export function validateInputs(window: HistoryWindow, asOf: string): void {
  HistoryWindowSchema.parse(window);
  InstantSchema.parse(asOf);
}

export function windowDates(window: HistoryWindow): LocalDate[] {
  return Array.from(
    { length: countCalendarDays(window.startDate, window.endDate) },
    (_, index) => addCalendarDays(window.startDate, index)
  );
}

export function observationId(
  sourceRecordId: string,
  metric: string,
  effectiveDate: LocalDate,
  sourceField: string
): string {
  const identity = [
    OURA_REST_SOURCE.kind,
    OURA_REST_SOURCE.channel,
    OURA_REST_SOURCE.datasetId,
    sourceRecordId,
    metric,
    effectiveDate,
    sourceField
  ];
  return `obs_${createHash("sha256").update(JSON.stringify(identity)).digest("hex")}`;
}

export function issueSortAndDedupe(issues: DataIssue[]): DataIssue[] {
  const key = (issue: DataIssue) =>
    `${issue.date ?? ""}\u0000${issue.metric ?? ""}\u0000${issue.code}`;
  const unique = new Map<string, DataIssue>();
  for (const issue of issues) unique.set(key(issue), issue);
  return [...unique.values()].sort((left, right) => key(left) < key(right) ? -1 : key(left) > key(right) ? 1 : 0);
}

export function failureReason(failure: ProviderFailure | null): MissingReason | null {
  if (failure === null) return null;
  switch (failure.code) {
    case "AUTHENTICATION_REQUIRED": return "authentication_required";
    case "PERMISSION_DENIED": return "permission_denied";
    case "LIMIT_REACHED": return "truncated";
    case "INVALID_PROVIDER_DATA":
    case "INVALID_REQUEST":
    case "PROVIDER_CONTRACT_CHANGED": return "invalid_provider_data";
    case "RATE_LIMITED":
    case "PROVIDER_UNAVAILABLE":
    case "CANCELLED": return "provider_unavailable";
  }
}

export function collectionFailureReason(collection: {
  complete: boolean;
  failure: ProviderFailure | null;
  fieldIssues: readonly ProviderFieldIssue[];
}): MissingReason | null {
  const reason = failureReason(collection.failure);
  if (reason !== null) return reason;
  return !collection.complete && collection.fieldIssues.length === 0 ? "truncated" : null;
}

export function historyStatus(
  observationCount: number,
  complete: boolean
): "complete" | "partial" | "unavailable" {
  if (observationCount === 0) return "unavailable";
  return complete ? "complete" : "partial";
}

export function fieldIssueDays(
  issues: readonly ProviderFieldIssue[],
  window: HistoryWindow,
  fields: ReadonlySet<string>,
  records: readonly { id: string; day: LocalDate }[] = []
): { days: Set<LocalDate>; unknown: boolean } {
  const days = new Set<LocalDate>();
  let unknown = false;
  for (const issue of issues) {
    if (!fields.has(issue.field)) continue;
    if (issue.day === null) unknown = true;
    else if (issue.day >= window.startDate && issue.day <= window.endDate) days.add(issue.day);
    if (issue.code === "conflict" && issue.recordId !== null) {
      for (const record of records) {
        if (record.id === issue.recordId && record.day >= window.startDate && record.day <= window.endDate) days.add(record.day);
      }
    }
  }
  return { days, unknown };
}

export function deduplicateById<T extends { id: string; day: LocalDate }>(
  records: readonly T[],
  window: HistoryWindow
): { records: T[]; conflictDays: Set<LocalDate> } {
  const byId = new Map<string, T>();
  const conflicts = new Set<string>();
  const conflictDays = new Set<LocalDate>();
  for (const record of records) {
    const previous = byId.get(record.id);
    if (previous === undefined) {
      byId.set(record.id, record);
      continue;
    }
    if (!sameFlatRecord(previous, record)) {
      conflicts.add(record.id);
      if (previous.day >= window.startDate && previous.day <= window.endDate) conflictDays.add(previous.day);
      if (record.day >= window.startDate && record.day <= window.endDate) conflictDays.add(record.day);
    }
  }
  return {
    records: [...byId.values()].filter((record) => !conflicts.has(record.id)),
    conflictDays
  };
}

type SleepSelection =
  | { kind: "selected"; record: SleepDto }
  | { kind: "missing"; reason: "not_recorded" | "unsupported" | "invalid_provider_data" };

const SLEEP_SELECTION_FIELDS = new Set([
  "record", "id", "day", "type", "total_sleep_duration", "bedtime_start", "bedtime_end"
]);

export function selectPrimarySleepByDay(
  collection: ProviderCollection<SleepDto>,
  window: HistoryWindow
): { selections: Map<LocalDate, SleepSelection>; unknownIssue: boolean } {
  const dates = windowDates(window);
  const deduplicated = deduplicateById(collection.records, window);
  const fieldIssues = fieldIssueDays(collection.fieldIssues, window, SLEEP_SELECTION_FIELDS, collection.records);
  for (const day of deduplicated.conflictDays) fieldIssues.days.add(day);

  const byDay = new Map<LocalDate, SleepDto[]>();
  for (const record of deduplicated.records) {
    if (record.day < window.startDate || record.day > window.endDate) continue;
    const existing = byDay.get(record.day) ?? [];
    existing.push(record);
    byDay.set(record.day, existing);
  }

  const selections = new Map<LocalDate, SleepSelection>();
  for (const day of dates) {
    if (fieldIssues.unknown || fieldIssues.days.has(day)) {
      selections.set(day, { kind: "missing", reason: "invalid_provider_data" });
      continue;
    }
    const records = byDay.get(day) ?? [];
    const eligible = records.filter((record) => record.type === "long_sleep");
    const invalidEligible = eligible.some((record) => {
      const start = InstantSchema.safeParse(record.bedtimeStart);
      const end = InstantSchema.safeParse(record.bedtimeEnd);
      const duration = record.totalSleepDuration;
      return !start.success || !end.success || Date.parse(record.bedtimeStart) > Date.parse(record.bedtimeEnd) ||
        (duration !== null && (!Number.isInteger(duration) || duration < 0));
    });
    if (invalidEligible) {
      selections.set(day, { kind: "missing", reason: "invalid_provider_data" });
      continue;
    }
    eligible.sort((left, right) => {
      if (left.totalSleepDuration === null && right.totalSleepDuration !== null) return 1;
      if (left.totalSleepDuration !== null && right.totalSleepDuration === null) return -1;
      if (left.totalSleepDuration !== right.totalSleepDuration) return (right.totalSleepDuration ?? 0) - (left.totalSleepDuration ?? 0);
      const endDifference = Date.parse(right.bedtimeEnd) - Date.parse(left.bedtimeEnd);
      return endDifference !== 0 ? endDifference : ordinalCompare(left.id, right.id);
    });
    const selected = eligible[0];
    if (selected !== undefined) selections.set(day, { kind: "selected", record: selected });
    else selections.set(day, {
      kind: "missing",
      reason: records.some((record) => record.type === null || !RECOGNIZED_SLEEP_TYPES.has(record.type))
        ? "unsupported"
        : "not_recorded"
    });
  }
  return { selections, unknownIssue: fieldIssues.unknown };
}

export function missingReasonForUnseen(
  collection: { failure: ProviderFailure | null },
  fallback: MissingReason
): MissingReason {
  return failureReason(collection.failure) ?? fallback;
}
