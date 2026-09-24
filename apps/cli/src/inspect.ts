import { parseArgs } from "node:util";
import {
  makeHistoryWindow,
  type HistoryWindow,
  type Instant,
  type LocalDate
} from "@ahp/health-domain";
import {
  createMacOSKeychainTokenStore,
  FileAuthLock,
  OuraSession,
  type OuraAuthConfig,
  type Result,
  type TokenStore
} from "@ahp/oura-client/auth";
import {
  normalizeRecovery,
  normalizeSleep,
  normalizeTraining
} from "@ahp/oura-client/normalize";
import {
  OuraRestTransport,
  type ProviderCollection,
  type ProviderFailure,
  type ReadinessDto,
  type SleepDto,
  type WorkoutDto
} from "@ahp/oura-client/transport";

type Output = (line: string) => void;
type InspectTransport = {
  listSleep(window: HistoryWindow): Promise<ProviderCollection<SleepDto>>;
  listReadiness(window: HistoryWindow): Promise<ProviderCollection<ReadinessDto>>;
  listWorkouts(window: HistoryWindow): Promise<ProviderCollection<WorkoutDto>>;
};
type InspectError =
  | ProviderFailure
  | { code: "CONFIG_INVALID"; retryable: false }
  | { code: "CREDENTIAL_STORE_UNAVAILABLE"; retryable: false };
type InspectDependencies = {
  environment?: NodeJS.ProcessEnv;
  store?: TokenStore;
  signal?: AbortSignal;
  clock?: () => Date;
  transport?: InspectTransport;
};
type InspectReport = {
  window: HistoryWindow;
  sleep: ReturnType<typeof normalizeSleep>;
  recovery: ReturnType<typeof normalizeRecovery>;
  training: ReturnType<typeof normalizeTraining>;
};

const USAGE = "Usage: health inspect --days <1..14> [--show-values]";

function configuration(environment: NodeJS.ProcessEnv): OuraAuthConfig | null {
  const clientId = environment.OURA_CLIENT_ID;
  const clientSecret = environment.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return {
    clientId,
    clientSecret,
    ...(environment.OURA_REDIRECT_URI ? { redirectUri: environment.OURA_REDIRECT_URI } : {})
  };
}

function localDate(date: Date): LocalDate {
  const year = String(date.getFullYear()).padStart(4, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}` as LocalDate;
}

async function systemTransport(dependencies: InspectDependencies): Promise<Result<InspectTransport, InspectError>> {
  const environment = dependencies.environment ?? process.env;
  const config = configuration(environment);
  if (config === null) return { ok: false, error: { code: "CONFIG_INVALID", retryable: false } };
  let store: TokenStore;
  try {
    store = dependencies.store ?? await createMacOSKeychainTokenStore(config.clientId);
  } catch {
    return { ok: false, error: { code: "CREDENTIAL_STORE_UNAVAILABLE", retryable: false } };
  }
  const session = new OuraSession(config, {
    store,
    lock: new FileAuthLock(config.clientId),
    ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal })
  });
  return {
    ok: true,
    value: new OuraRestTransport(session, {
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal })
    })
  };
}

function terminalFailure(collections: readonly ProviderCollection<unknown>[]): InspectError | null {
  const failures = collections.flatMap((collection) => collection.failure === null ? [] : [collection.failure]);
  const cancellation = failures.find((failure) => failure.code === "CANCELLED");
  if (cancellation !== undefined) return cancellation;
  const authentication = failures.find((failure) => failure.code === "AUTHENTICATION_REQUIRED");
  if (authentication !== undefined) return authentication;
  const invalidRequest = failures.find((failure) => failure.code === "INVALID_REQUEST");
  if (invalidRequest !== undefined) return invalidRequest;
  const anyUsable = collections.some((collection) => collection.failure === null || collection.records.length > 0);
  return anyUsable ? null : failures[0] ?? null;
}

export async function inspectRecentHistory(
  days: number,
  dependencies: InspectDependencies = {}
): Promise<Result<InspectReport, InspectError>> {
  if (!Number.isInteger(days) || days < 1 || days > 14) {
    return { ok: false, error: { code: "INVALID_REQUEST", retryable: false, retryAfterSeconds: null } };
  }
  const frozen = (dependencies.clock ?? (() => new Date()))();
  if (!Number.isFinite(frozen.getTime())) {
    return { ok: false, error: { code: "INVALID_REQUEST", retryable: false, retryAfterSeconds: null } };
  }
  const asOf = frozen.toISOString() as Instant;
  const window = makeHistoryWindow(localDate(frozen), days);
  const transportResult = dependencies.transport === undefined
    ? await systemTransport(dependencies)
    : { ok: true as const, value: dependencies.transport };
  if (!transportResult.ok) return transportResult;

  let sleep: ProviderCollection<SleepDto>;
  let readiness: ProviderCollection<ReadinessDto>;
  let workouts: ProviderCollection<WorkoutDto>;
  try {
    [sleep, readiness, workouts] = await Promise.all([
      transportResult.value.listSleep(window),
      transportResult.value.listReadiness(window),
      transportResult.value.listWorkouts(window)
    ]);
  } catch {
    return { ok: false, error: { code: "PROVIDER_UNAVAILABLE", retryable: true, retryAfterSeconds: null } };
  }
  const failure = terminalFailure([sleep, readiness, workouts]);
  if (failure !== null) return { ok: false, error: failure };

  try {
    return {
      ok: true,
      value: {
        window,
        sleep: normalizeSleep(sleep, window, asOf),
        recovery: normalizeRecovery(readiness, sleep, window, asOf),
        training: normalizeTraining(workouts, window, asOf)
      }
    };
  } catch {
    return { ok: false, error: { code: "INVALID_PROVIDER_DATA", retryable: false, retryAfterSeconds: null } };
  }
}

function errorText(code: InspectError["code"]): string {
  const messages: Record<InspectError["code"], string> = {
    CONFIG_INVALID: "Oura configuration is invalid.",
    CREDENTIAL_STORE_UNAVAILABLE: "Credential storage is unavailable.",
    AUTHENTICATION_REQUIRED: "No usable Oura session is available. Run health auth login.",
    PERMISSION_DENIED: "The Oura session does not grant access to the requested history.",
    RATE_LIMITED: "Oura history is temporarily rate limited.",
    PROVIDER_UNAVAILABLE: "Oura history is temporarily unavailable.",
    INVALID_PROVIDER_DATA: "Oura returned history that could not be validated.",
    INVALID_REQUEST: "The history request is invalid.",
    PROVIDER_CONTRACT_CHANGED: "The Oura history contract is not supported.",
    LIMIT_REACHED: "The bounded Oura history limit was reached.",
    CANCELLED: "History inspection was cancelled."
  };
  return messages[code];
}

function exitCode(error: InspectError): number {
  if (error.code === "CANCELLED") return 130;
  if (error.code === "CONFIG_INVALID" || error.code === "INVALID_REQUEST") return 2;
  if (error.code === "CREDENTIAL_STORE_UNAVAILABLE" || error.code === "AUTHENTICATION_REQUIRED" || error.code === "PERMISSION_DENIED") return 3;
  return 4;
}

function availableDates(states: Array<{ date: string; available: boolean }>): string {
  const dates = states.filter((state) => state.available).map((state) => state.date);
  return dates.length === 0 ? "none" : dates.join(", ");
}

function render(report: InspectReport, showValues: boolean): string[] {
  const sleepAvailable = report.sleep.days.filter((day) => day.duration.status === "available");
  const readinessAvailable = report.recovery.days.filter((day) => day.readiness.status === "available");
  const heartRateAvailable = report.recovery.days.filter((day) => day.lowestSleepHeartRate.status === "available");
  const trainingDays = report.training.days.filter((day) => day.sessions.length > 0);
  const sessionCount = trainingDays.reduce((count, day) => count + day.sessions.length, 0);
  const totalDays = report.sleep.days.length;
  const lines = [
    "Local Oura REST inspection (no model or agent use).",
    `Window: ${report.window.startDate} through ${report.window.endDate}.`,
    `Sleep: ${report.sleep.status}; ${sleepAvailable.length}/${totalDays} dates available; dates ${availableDates(report.sleep.days.map((day) => ({ date: day.date, available: day.duration.status === "available" })))}.`,
    `Recovery: ${report.recovery.status}; readiness ${readinessAvailable.length}/${totalDays}; lowest sleep heart rate ${heartRateAvailable.length}/${totalDays}; dates ${availableDates(report.recovery.days.map((day) => ({ date: day.date, available: day.readiness.status === "available" || day.lowestSleepHeartRate.status === "available" })))}.`,
    `Training: ${report.training.status}; ${sessionCount} sessions across ${trainingDays.length}/${totalDays} dates; dates ${trainingDays.length === 0 ? "none" : trainingDays.map((day) => day.date).join(", ")}.`
  ];
  if (!showValues) return lines;
  lines.push(
    `Sleep values: ${sleepAvailable.length === 0 ? "none" : sleepAvailable.flatMap((day) => day.duration.status === "available" ? [`${day.date}=${day.duration.observation.value} seconds`] : []).join(", ")}.`,
    `Readiness values: ${readinessAvailable.length === 0 ? "none" : readinessAvailable.flatMap((day) => day.readiness.status === "available" ? [`${day.date}=${day.readiness.observation.value} score`] : []).join(", ")}.`,
    `Lowest sleep heart-rate values: ${heartRateAvailable.length === 0 ? "none" : heartRateAvailable.flatMap((day) => day.lowestSleepHeartRate.status === "available" ? [`${day.date}=${day.lowestSleepHeartRate.observation.value} bpm`] : []).join(", ")}.`,
    `Training values: ${trainingDays.length === 0 ? "none" : trainingDays.flatMap((day) => day.sessions.flatMap((session) => session.activity.status === "available" && session.duration.status === "available" ? [`${day.date}=${session.activity.observation.value}/${session.duration.observation.value} seconds`] : [])).join(", ")}.`
  );
  return lines;
}

export async function runInspectCommand(
  argv: readonly string[],
  output: Output,
  dependencies: InspectDependencies = {}
): Promise<number> {
  let values: { days?: string; "show-values": boolean };
  try {
    const parsed = parseArgs({
      args: [...argv],
      allowPositionals: false,
      strict: true,
      tokens: true,
      options: {
        days: { type: "string" },
        "show-values": { type: "boolean", default: false }
      }
    });
    const optionNames = parsed.tokens.filter((token) => token.kind === "option").map((token) => token.name);
    if (new Set(optionNames).size !== optionNames.length) throw new Error("duplicate option");
    values = parsed.values;
  } catch {
    output(USAGE);
    return 2;
  }
  if (values.days === undefined || !/^(?:[1-9]|1[0-4])$/.test(values.days)) {
    output(USAGE);
    return 2;
  }
  const result = await inspectRecentHistory(Number(values.days), dependencies);
  if (!result.ok) {
    output(errorText(result.error.code));
    return exitCode(result.error);
  }
  for (const line of render(result.value, values["show-values"])) output(line);
  return 0;
}
