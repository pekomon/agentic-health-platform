import {
  SleepHistoryResultSchema,
  type DataIssue,
  type HistoryWindow,
  type Instant,
  type SleepDay
} from "@ahp/health-domain";

import type { ProviderCollection, SleepDto } from "../transport/types.js";
import {
  OURA_REST_SOURCE,
  collectionFailureReason,
  historyStatus,
  issueSortAndDedupe,
  observationId,
  selectPrimarySleepByDay,
  validateInputs,
  windowDates
} from "./common.js";

export function normalizeSleep(
  collection: ProviderCollection<SleepDto>,
  window: HistoryWindow,
  asOf: Instant
) {
  validateInputs(window, asOf);
  const { selections } = selectPrimarySleepByDay(collection, window);
  const transportReason = collectionFailureReason(collection);
  const issues: DataIssue[] = [];
  let observationCount = 0;

  const days: SleepDay[] = windowDates(window).map((date) => {
    const selection = selections.get(date)!;
    if (selection.kind === "missing") {
      const reason = selection.reason === "invalid_provider_data"
        ? selection.reason
        : transportReason ?? selection.reason;
      issues.push({ code: reason, date, metric: "sleep.duration" });
      return { date, duration: { status: "missing", reason } };
    }
    const record = selection.record;
    if (record.totalSleepDuration === null) {
      const reason = "not_recorded";
      issues.push({ code: reason, date, metric: "sleep.duration" });
      return { date, duration: { status: "missing", reason } };
    }
    const elapsed = (Date.parse(record.bedtimeEnd) - Date.parse(record.bedtimeStart)) / 1000;
    if (record.totalSleepDuration > elapsed) {
      issues.push({ code: "invalid_provider_data", date, metric: "sleep.duration" });
      return { date, duration: { status: "missing", reason: "invalid_provider_data" } };
    }
    observationCount++;
    return {
      date,
      duration: {
        status: "available",
        observation: {
          id: observationId(record.id, "sleep.duration", date, "sleep.duration"),
          metric: "sleep.duration",
          value: record.totalSleepDuration,
          unit: "seconds",
          source: OURA_REST_SOURCE,
          effectiveDate: date,
          period: { start: record.bedtimeStart, end: record.bedtimeEnd },
          recordedAt: record.bedtimeEnd,
          sourceRecordId: record.id,
          sourceField: "sleep.duration",
          derivation: null
        }
      }
    };
  });

  if (transportReason !== null && observationCount > 0) {
    issues.push({ code: transportReason, date: null, metric: null });
  }
  const normalizedIssues = issueSortAndDedupe(issues);
  return SleepHistoryResultSchema.parse({
    schemaVersion: 1,
    window,
    asOf,
    status: historyStatus(observationCount, normalizedIssues.length === 0),
    days,
    issues: normalizedIssues
  });
}
