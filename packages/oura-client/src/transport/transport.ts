import { HistoryWindowSchema, LocalDateSchema, type HistoryWindow, type LocalDate } from "@ahp/health-domain";
import type { OuraSession } from "../auth/session.js";
import type { SessionError } from "../auth/types.js";
import type { OuraRestTransportOptions, ProviderCollection, ProviderFailure, ProviderFieldIssue, ReadinessDto, SleepDto, WorkoutDto } from "./types.js";

const ORIGIN = "https://api.ouraring.com";
const DEFAULTS = { maxPages: 10, maxRecordsPerPage: 200, maxResponseBytes: 1024 * 1024, totalDeadlineMs: 30_000, attemptTimeoutMs: 10_000 };
type Kind = "sleep" | "readiness" | "workout"; type Dto = SleepDto | ReadinessDto | WorkoutDto;
type SessionSurface = Pick<OuraSession, "withAccessToken" | "refreshAfterUnauthorized" | "getStatus">;
type Bound<T> = { kind: "value"; value: T } | { kind: "caller" } | { kind: "deadline" };
type Body = { kind: "bytes"; value: Uint8Array } | { kind: "aborted" } | { kind: "invalid" };
const fail = <C extends ProviderFailure["code"]>(code: C, retryAfterSeconds: number | null = null) => ({ code, retryable: code === "RATE_LIMITED" || code === "PROVIDER_UNAVAILABLE" || code === "CANCELLED", retryAfterSeconds } as Extract<ProviderFailure, { code: C }>);
const empty = <T>(): ProviderCollection<T> => ({ records: [], complete: true, failure: null, fieldIssues: [] });
const obj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const string = (v: unknown): string | null => typeof v === "string" && v.length > 0 ? v : null;
const date = (v: unknown): LocalDate | null => typeof v === "string" && LocalDateSchema.safeParse(v).success ? v as LocalDate : null;
const number = (v: unknown): number | null => typeof v === "number" && Number.isFinite(v) ? v : null;

export class OuraRestTransport {
  private readonly fetchImpl: typeof fetch; private readonly now: () => number; private readonly limits: typeof DEFAULTS;
  constructor(private readonly session: SessionSurface, private readonly options: OuraRestTransportOptions = {}) { this.fetchImpl = options.fetch ?? fetch; this.now = options.now ?? Date.now; this.limits = { ...DEFAULTS, ...options.limits }; }
  listSleep(window: HistoryWindow): Promise<ProviderCollection<SleepDto>> { return this.list("sleep", window); }
  listReadiness(window: HistoryWindow): Promise<ProviderCollection<ReadinessDto>> { return this.list("readiness", window); }
  listWorkouts(window: HistoryWindow): Promise<ProviderCollection<WorkoutDto>> { return this.list("workout", window); }

  private async list<T extends Dto>(kind: Kind, raw: HistoryWindow): Promise<ProviderCollection<T>> {
    const checked = HistoryWindowSchema.safeParse(raw); if (!checked.success) return this.end(empty<T>(), fail("INVALID_REQUEST"));
    const result = empty<T>(), began = this.now(), all = new AbortController(), timer = setTimeout(() => all.abort(), this.limits.totalDeadlineMs), seen = new Set<string>(); let token: string | null = null;
    try {
      const statusResult = await this.bound(this.session.getStatus(), all.signal);
      if (statusResult.kind === "caller") return this.cancel(result);
      if (statusResult.kind === "deadline") return this.end(result, fail("PROVIDER_UNAVAILABLE"));
      const status = statusResult.value; if (!status.ok) return this.auth(result);
      const scope = kind === "workout" ? "workout" : "daily";
      if (status.value.grantedScopes !== null && !status.value.grantedScopes.includes(scope)) return this.end(result, fail("PERMISSION_DENIED"));
      for (let page = 0; page < this.limits.maxPages; page++) {
        if (this.options.signal?.aborted) return this.cancel(result);
        if (all.signal.aborted || this.now() - began >= this.limits.totalDeadlineMs) return this.end(result, fail("PROVIDER_UNAVAILABLE"));
        const got = await this.page(kind, checked.data, token, all.signal);
        if (got.kind === "failure") return got.auth ? this.auth(result) : got.failure.code === "CANCELLED" ? this.cancel(result) : this.end(result, got.failure);
        if (got.data.length > this.limits.maxRecordsPerPage) return this.end(result, fail("LIMIT_REACHED"));
        for (const value of got.data) this.project(kind, value, checked.data, result as ProviderCollection<Dto>);
        if (got.next === null) return result;
        if (seen.has(got.next)) return this.end(result, fail("INVALID_PROVIDER_DATA"));
        seen.add(got.next); token = got.next;
        if (page === this.limits.maxPages - 1) return this.end(result, fail("LIMIT_REACHED"));
      } return this.end(result, fail("LIMIT_REACHED"));
    } finally { clearTimeout(timer); }
  }
  private end<T>(r: ProviderCollection<T>, f: ProviderFailure): ProviderCollection<T> { r.complete = false; r.failure = f; return r; }
  private cancel<T>(_r: ProviderCollection<T>): ProviderCollection<T> { return { records: [], complete: false, failure: fail("CANCELLED"), fieldIssues: [] }; }
  private auth<T>(_r: ProviderCollection<T>): ProviderCollection<T> { return { records: [], complete: false, failure: fail("AUTHENTICATION_REQUIRED"), fieldIssues: [] }; }
  private bound<T>(promise: Promise<T>, deadline: AbortSignal): Promise<Bound<T>> { return new Promise((resolve) => { let done = false; const finish = (value: Bound<T>) => { if (done) return; done = true; this.options.signal?.removeEventListener("abort", caller); deadline.removeEventListener("abort", expired); resolve(value); }; const caller = () => finish({ kind: "caller" }); const expired = () => finish({ kind: "deadline" }); if (this.options.signal?.aborted) return caller(); if (deadline.aborted) return expired(); this.options.signal?.addEventListener("abort", caller, { once: true }); deadline.addEventListener("abort", expired, { once: true }); promise.then(value => finish({ kind: "value", value }), () => finish({ kind: "deadline" })); }); }

  private async page(kind: Kind, window: HistoryWindow, token: string | null, signal: AbortSignal): Promise<{ kind: "ok"; data: unknown[]; next: string | null } | { kind: "failure"; failure: ProviderFailure; auth: boolean }> {
    let used: string | null = null;
    const acquired = await this.bound(this.session.withAccessToken(async access => { used = access; return this.request(kind, window, token, access, signal); }), signal);
    if (acquired.kind === "caller") return { kind: "failure", failure: fail("CANCELLED"), auth: false };
    if (acquired.kind === "deadline") return { kind: "failure", failure: fail("PROVIDER_UNAVAILABLE"), auth: false };
    const got = acquired.value;
    if (!got.ok) return { kind: "failure", failure: this.sessionFailure(got.error), auth: true };
    let response = got.value;
    if (response.kind === "ok" && response.status === 401) {
      const refreshResult = await this.bound(this.session.refreshAfterUnauthorized(used!), signal);
      if (refreshResult.kind === "caller") return { kind: "failure", failure: fail("CANCELLED"), auth: false };
      if (refreshResult.kind === "deadline") return { kind: "failure", failure: fail("PROVIDER_UNAVAILABLE"), auth: false };
      const refreshed = refreshResult.value; if (!refreshed.ok) return { kind: "failure", failure: this.sessionFailure(refreshed.error), auth: true };
      response = await this.request(kind, window, token, refreshed.value, signal);
      if (response.kind === "ok" && response.status === 401) return { kind: "failure", failure: fail("AUTHENTICATION_REQUIRED"), auth: true };
    }
    if (response.kind === "error") return { kind: "failure", failure: response.failure, auth: false };
    if (response.status === 403) return { kind: "failure", failure: fail("PERMISSION_DENIED"), auth: false };
    if (response.status === 404) return { kind: "failure", failure: fail("PROVIDER_CONTRACT_CHANGED"), auth: false };
    if (response.status === 429) return { kind: "failure", failure: fail("RATE_LIMITED", response.retryAfter), auth: false };
    if (response.status === 400 || response.status === 422) return { kind: "failure", failure: fail("INVALID_REQUEST"), auth: false };
    if (response.status < 200 || response.status >= 300) return { kind: "failure", failure: fail("PROVIDER_UNAVAILABLE"), auth: false };
    if (!obj(response.json) || !Array.isArray(response.json.data) || !(response.json.next_token === null || typeof response.json.next_token === "string")) return { kind: "failure", failure: fail("INVALID_PROVIDER_DATA"), auth: false };
    return { kind: "ok", data: response.json.data, next: response.json.next_token };
  }
  private async request(kind: Kind, w: HistoryWindow, next: string | null, token: string, deadline: AbortSignal): Promise<{ kind: "ok"; status: number; json: unknown; retryAfter: number | null } | { kind: "error"; failure: ProviderFailure }> {
    if (this.options.signal?.aborted) return { kind: "error", failure: fail("CANCELLED") };
    if (deadline.aborted) return { kind: "error", failure: fail("PROVIDER_UNAVAILABLE") };
    const control = new AbortController(); let caller = false, timeout = false, deadlineExpired = false; const callerAbort = () => { caller = true; control.abort(); }, deadlineAbort = () => { deadlineExpired = true; control.abort(); };
    this.options.signal?.addEventListener("abort", callerAbort, { once: true }); deadline.addEventListener("abort", deadlineAbort, { once: true }); const timer = setTimeout(() => { timeout = true; control.abort(); }, this.limits.attemptTimeoutMs);
    try {
      const path = kind === "readiness" ? "daily_readiness" : kind, url = new URL(`/v2/usercollection/${path}`, ORIGIN);
      url.searchParams.set("start_date", w.startDate); url.searchParams.set("end_date", w.endDate); if (next !== null) url.searchParams.set("next_token", next);
      url.searchParams.set("fields", kind === "sleep" ? "id,day,bedtime_start,bedtime_end,type,total_sleep_duration,lowest_heart_rate" : kind === "readiness" ? "id,day,timestamp,score" : "id,day,start_datetime,end_datetime,activity");
      const response = await this.fetchImpl(url, { method: "GET", headers: { Authorization: `Bearer ${token}` }, redirect: "error", signal: control.signal });
      const retryAfter = this.retryAfter(response.headers.get("retry-after")); if (!response.ok) return { kind: "ok", status: response.status, json: null, retryAfter };
      const bytes = await this.body(response, control.signal); if (bytes.kind === "aborted") return { kind: "error", failure: caller ? fail("CANCELLED") : fail("PROVIDER_UNAVAILABLE") }; if (bytes.kind === "invalid") return { kind: "error", failure: fail("INVALID_PROVIDER_DATA") };
      try { return { kind: "ok", status: response.status, json: JSON.parse(new TextDecoder().decode(bytes.value)), retryAfter }; } catch { return { kind: "error", failure: fail("INVALID_PROVIDER_DATA") }; }
    } catch { return { kind: "error", failure: caller ? fail("CANCELLED") : timeout || deadlineExpired ? fail("PROVIDER_UNAVAILABLE") : fail("PROVIDER_UNAVAILABLE") }; }
    finally { clearTimeout(timer); this.options.signal?.removeEventListener("abort", callerAbort); deadline.removeEventListener("abort", deadlineAbort); }
  }
  private async body(response: Response, signal: AbortSignal): Promise<Body> { if (response.body === null) return { kind: "invalid" }; const reader = response.body.getReader(), chunks: Uint8Array[] = []; let size = 0; const read = () => new Promise<ReadableStreamReadResult<Uint8Array>>((resolve, reject) => { const stop = () => { cleanup(); void reader.cancel(); reject(new DOMException("", "AbortError")); }; const cleanup = () => signal.removeEventListener("abort", stop); if (signal.aborted) return stop(); signal.addEventListener("abort", stop, { once: true }); reader.read().then(value => { cleanup(); resolve(value); }, reason => { cleanup(); reject(reason); }); }); try { while (true) { const next = await read(); if (next.done) break; size += next.value.byteLength; if (size > this.limits.maxResponseBytes) { await reader.cancel(); return { kind: "invalid" }; } chunks.push(next.value); } } catch { return signal.aborted ? { kind: "aborted" } : { kind: "invalid" }; } const out = new Uint8Array(size); let offset = 0; for (const c of chunks) { out.set(c, offset); offset += c.byteLength; } return { kind: "bytes", value: out }; }
  private retryAfter(v: string | null): number | null { if (v === null || !/^\d+$/.test(v)) return null; const n = Number(v); return Number.isSafeInteger(n) && n <= 3600 ? n : null; }
  private sessionFailure(e: SessionError): ProviderFailure { return e.code === "CANCELLED" ? fail("CANCELLED") : fail("AUTHENTICATION_REQUIRED"); }
  private project(kind: Kind, v: unknown, w: HistoryWindow, r: ProviderCollection<Dto>): void {
    const push = (recordId: string | null, day: LocalDate | null, field: string, code: ProviderFieldIssue["code"] = "invalid") => { r.fieldIssues.push({ recordId, day, field, code }); r.complete = false; };
    if (!obj(v)) return push(null, null, "record"); const id = string(v.id), day = date(v.day); if (!id || !day) return push(id, day, !id ? "id" : "day"); if (day < w.startDate || day > w.endDate) return push(id, day, "day");
    let item: Dto | null = null;
    if (kind === "sleep") { const a = string(v.bedtime_start), b = string(v.bedtime_end), type = v.type == null ? null : string(v.type), duration = v.total_sleep_duration == null ? null : number(v.total_sleep_duration), hr = v.lowest_heart_rate == null ? null : number(v.lowest_heart_rate); if (!a || !b) return push(id, day, !a ? "bedtime_start" : "bedtime_end"); item = { id, day, bedtimeStart: a, bedtimeEnd: b, type, totalSleepDuration: duration, lowestHeartRate: hr }; if (v.type != null && type === null) push(id, day, "type"); if (v.total_sleep_duration != null && duration === null) push(id, day, "total_sleep_duration"); if (v.lowest_heart_rate != null && hr === null) push(id, day, "lowest_heart_rate"); }
    if (kind === "readiness") { const timestamp = string(v.timestamp), score = v.score == null ? null : number(v.score); if (!timestamp) return push(id, day, "timestamp"); item = { id, day, timestamp, score }; if (v.score != null && score === null) push(id, day, "score"); }
    if (kind === "workout") { const a = string(v.start_datetime), b = string(v.end_datetime), activity = string(v.activity); if (!a || !b || !activity) return push(id, day, !a ? "start_datetime" : !b ? "end_datetime" : "activity"); item = { id, day, startDatetime: a, endDatetime: b, activity }; }
    const existing = r.records.find(x => x.id === id);
    if (existing !== undefined) {
      if (JSON.stringify(existing) === JSON.stringify(item)) return;
      return push(id, day, "id", "conflict");
    }
    r.records.push(item!);
  }
}
