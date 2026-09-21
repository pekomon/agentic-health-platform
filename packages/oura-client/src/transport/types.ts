export type OuraPaginationToken = string;

export type OuraTimestamp = string;

export type OuraResponseMetadata = {
  /** The time at which the response was generated */
  timestamp: OuraTimestamp;
  /** A token used to fetch the next page of results, or null if this is the last page */
  nextToken?: OuraPaginationToken | null;
};

export type OuraSleepItem = {
  id: string;
  timestamp: OuraTimestamp;
  duration: number;
  total: number;
  deep: number;
  rem: number;
  awake: number;
  efficiency: number;
  latency: number;
  noise: number;
  score: number;
};

export type OuraReadinessItem = {
  id: string;
  timestamp: OuraTimestamp;
  score: number;
  activity: number;
  recovery: number;
  sleep: number;
  activity_balance: number;
  daily_readiness: boolean;
  respiratory_rate: number;
  hr_lowest: number;
  temperature_delta: number;
  temperature_trend: string;
};

export type OuraWorkoutItem = {
  id: string;
  timestamp: OuraTimestamp;
  duration: number;
  type: string;
  calories: number;
  heart_rate: number;
  heart_rate_zone: string;
  respiratory_rate: number;
  temperature_delta: number;
  temperature_trend: string;
  score: number;
};

export type ListSleepResponse = {
  data: OuraSleepItem[];
  page: OuraResponseMetadata;
};

export type ListReadinessResponse = {
  data: OuraReadinessItem[];
  page: OuraResponseMetadata;
};

export type ListWorkoutsResponse = {
  data: OuraWorkoutItem[];
  page: OuraResponseMetadata;
};

export type OuraClientError =
  | { code: "INVALID_PAGE_SIZE"; message: string }
  | { code: "INVALID_PAGE_COUNT"; message: string }
  | { code: "RESPONSE_TOO_LARGE"; message: string }
  | { code: "TIMEOUT"; message: string }
  | { code: "CANCELLED"; message: string }
  | { code: "AUTHENTICATION_FAILED"; message: string }
  | { code: "UNAUTHORIZED"; message: string }
  | { code: "FORBIDDEN"; message: string }
  | { code: "NOT_FOUND"; message: string }
  | { code: "INTERNAL_ERROR"; message: string }
  | { code: "INVALID_RESPONSE"; message: string };

export type Result<T, E extends OuraClientError> = 
  | { ok: true; value: T } 
  | { ok: false; error: E };