import {
  InstantSchema,
  RecoveryHistoryResultSchema,
  type DataIssue,
  type HistoryWindow,
  type Instant,
  type LocalDate,
  type MissingReason,
  type RecoveryDay
} from "@ahp/health-domain";

import type { ProviderCollection, ReadinessDto, SleepDto } from "../transport/types.js";
import {
  OURA_REST_SOURCE,
  collectionFailureReason,
  deduplicateById,
  fieldIssueDays,
  historyStatus,
  issueSortAndDedupe,
  observationId,
  selectPrimarySleepByDay,
  validateInputs,
  windowDates
} from "./common.js";

const READINESS_FIELDS = new Set(["record", "id", "day", "timestamp", "score"]);

function missing(reason: MissingReason) {
  return { status: "missing" as const, reason };
}

export function normalizeRecovery(
  readinessCollection: ProviderCollection<ReadinessDto>,
  sleepCollection: ProviderCollection<SleepDto>,
  window: HistoryWindow,
  asOf: Instant
) {
  validateInputs(window, asOf);
  const dates = windowDates(window);
  const readinessDeduplicated = deduplicateById(readinessCollection.records, window);
  const readinessIssues = fieldIssueDays(readinessCollection.fieldIssues, window, READINESS_FIELDS, readinessCollection.records);
  for (const day of readinessDeduplicated.conflictDays) readinessIssues.days.add(day);
  const readinessByDay = new Map<LocalDate, ReadinessDto[]>();
  for (const record of readinessDeduplicated.records) {
    if (record.day < window.startDate || record.day > window.endDate) continue;
    const records = readinessByDay.get(record.day) ?? [];
    records.push(record);
    readinessByDay.set(record.day, records);
  }

  const sleepSelection = selectPrimarySleepByDay(sleepCollection, window);
  const lowestHeartRateUnknown = sleepCollection.fieldIssues.some((issue) =>
    issue.field === "lowest_heart_rate" && issue.day === null
  );
  const readinessFailure = collectionFailureReason(readinessCollection);
  const sleepFailure = collectionFailureReason(sleepCollection);
  const issues: DataIssue[] = [];
  let observationCount = 0;

  const days: RecoveryDay[] = dates.map((date) => {
    const readinessRecords = readinessByDay.get(date) ?? [];
    let readinessReason: MissingReason | null = null;
    if (readinessIssues.unknown || readinessIssues.days.has(date) || readinessRecords.length > 1) {
      readinessReason = "invalid_provider_data";
    } else if (readinessRecords.length === 0) {
      readinessReason = readinessFailure ?? "not_recorded";
    }
    const readinessRecord = readinessRecords[0];
    const readiness = readinessReason !== null
      ? missing(readinessReason)
      : readinessRecord === undefined
        ? missing(readinessFailure ?? "not_recorded")
        : !InstantSchema.safeParse(readinessRecord.timestamp).success
          ? missing("invalid_provider_data")
          : readinessRecord.score === null
            ? missing("not_recorded")
            : !Number.isInteger(readinessRecord.score) || readinessRecord.score < 0 || readinessRecord.score > 100
              ? missing("invalid_provider_data")
          : {
              status: "available" as const,
              observation: {
                id: observationId(readinessRecord.id, "oura.readiness_score", date, "oura.readiness_score"),
                metric: "oura.readiness_score" as const,
                value: readinessRecord.score,
                unit: "score" as const,
                source: OURA_REST_SOURCE,
                effectiveDate: date,
                period: null,
                recordedAt: readinessRecord.timestamp,
                sourceRecordId: readinessRecord.id,
                sourceField: "oura.readiness_score" as const,
                derivation: null
              }
            };

    const selection = sleepSelection.selections.get(date)!;
    let lowestSleepHeartRate: RecoveryDay["lowestSleepHeartRate"];
    if (selection.kind === "missing") {
      lowestSleepHeartRate = missing(selection.reason === "invalid_provider_data"
        ? selection.reason
        : sleepFailure ?? selection.reason);
    } else {
      const record = selection.record;
      const invalidField = lowestHeartRateUnknown ||
        sleepCollection.fieldIssues.some((issue) =>
          issue.field === "lowest_heart_rate" &&
          (issue.recordId === record.id || (issue.recordId === null && issue.day === date))
        );
      if (invalidField) lowestSleepHeartRate = missing("invalid_provider_data");
      else if (record.lowestHeartRate === null) lowestSleepHeartRate = missing("not_recorded");
      else if (!Number.isInteger(record.lowestHeartRate) || record.lowestHeartRate <= 0) lowestSleepHeartRate = missing("invalid_provider_data");
      else lowestSleepHeartRate = {
        status: "available",
        observation: {
          id: observationId(record.id, "oura.sleep_lowest_heart_rate", date, "oura.sleep_lowest_heart_rate"),
          metric: "oura.sleep_lowest_heart_rate",
          value: record.lowestHeartRate,
          unit: "bpm",
          source: OURA_REST_SOURCE,
          effectiveDate: date,
          period: { start: record.bedtimeStart, end: record.bedtimeEnd },
          recordedAt: record.bedtimeEnd,
          sourceRecordId: record.id,
          sourceField: "oura.sleep_lowest_heart_rate",
          derivation: null
        }
      };
    }

    for (const [metric, state] of [
      ["oura.readiness_score", readiness],
      ["oura.sleep_lowest_heart_rate", lowestSleepHeartRate]
    ] as const) {
      if (state.status === "available") observationCount++;
      else issues.push({ code: state.reason, date, metric });
    }
    return { date, readiness, lowestSleepHeartRate };
  });

  if (readinessFailure !== null && days.some((day) => day.readiness.status === "available")) {
    issues.push({ code: readinessFailure, date: null, metric: null });
  }
  if (sleepFailure !== null && days.some((day) => day.lowestSleepHeartRate.status === "available")) {
    issues.push({ code: sleepFailure, date: null, metric: null });
  }
  const normalizedIssues = issueSortAndDedupe(issues);
  return RecoveryHistoryResultSchema.parse({
    schemaVersion: 1,
    window,
    asOf,
    status: historyStatus(observationCount, normalizedIssues.length === 0),
    days,
    issues: normalizedIssues
  });
}
