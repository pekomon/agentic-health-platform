import type { HistoryWindow, LocalDate } from "@ahp/health-domain";
export type { HistoryWindow, LocalDate };
export type ProviderFieldIssue = { recordId: string | null; day: LocalDate | null; field: string; code: "invalid" | "conflict" };
export type ProviderFailure =
  | { code: "AUTHENTICATION_REQUIRED"; retryable: false; retryAfterSeconds: null }
  | { code: "PERMISSION_DENIED"; retryable: false; retryAfterSeconds: null }
  | { code: "RATE_LIMITED"; retryable: true; retryAfterSeconds: number | null }
  | { code: "PROVIDER_UNAVAILABLE"; retryable: true; retryAfterSeconds: null }
  | { code: "INVALID_PROVIDER_DATA"; retryable: false; retryAfterSeconds: null }
  | { code: "INVALID_REQUEST"; retryable: false; retryAfterSeconds: null }
  | { code: "PROVIDER_CONTRACT_CHANGED"; retryable: false; retryAfterSeconds: null }
  | { code: "LIMIT_REACHED"; retryable: false; retryAfterSeconds: null }
  | { code: "CANCELLED"; retryable: true; retryAfterSeconds: null };
export type ProviderCollection<T> = { records: T[]; complete: boolean; failure: ProviderFailure | null; fieldIssues: ProviderFieldIssue[] };
export type SleepDto = { id: string; day: LocalDate; bedtimeStart: string; bedtimeEnd: string; type: string | null; totalSleepDuration: number | null; lowestHeartRate: number | null };
export type ReadinessDto = { id: string; day: LocalDate; timestamp: string; score: number | null };
export type WorkoutDto = { id: string; day: LocalDate; startDatetime: string; endDatetime: string; activity: string };
export type OuraRestTransportOptions = { fetch?: typeof fetch; signal?: AbortSignal; now?: () => number; limits?: Partial<{ maxPages: number; maxRecordsPerPage: number; maxResponseBytes: number; totalDeadlineMs: number; attemptTimeoutMs: number }> };
