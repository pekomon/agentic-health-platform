import { describe, expect, it, vi } from "vitest";
import { OuraRestTransport } from "../src/transport/index.js";

const window = { startDate: "2026-01-01", endDate: "2026-01-02" } as const;
const response = (body: unknown, status = 200, headers?: HeadersInit) => new Response(JSON.stringify(body), { status, headers });
const session = (overrides: Record<string, unknown> = {}) => ({
  getStatus: vi.fn(async () => ({ ok: true, value: { state: "authenticated", expiresAt: null, grantedScopes: ["daily", "workout"] } })),
  withAccessToken: vi.fn(async (fn: (token: string) => Promise<unknown>) => ({ ok: true, value: await fn("canary-token") })),
  refreshAfterUnauthorized: vi.fn(async () => ({ ok: true, value: "fresh-token" })), ...overrides
});
const sleep = { id: "sleep-1", day: "2026-01-01", bedtime_start: "2026-01-01T22:00:00Z", bedtime_end: "2026-01-02T06:00:00Z", type: "long_sleep", total_sleep_duration: 28800, lowest_heart_rate: 49, ignored: "secret" };

describe("OuraRestTransport", () => {
  it("executes all collection paths with fixed origin, exact date/query fields, and allowlisted DTOs", async () => {
    const fetch = vi.fn(async (input: URL) => response({ data: [input.pathname.endsWith("sleep") ? sleep : input.pathname.endsWith("daily_readiness") ? { id: "r", day: "2026-01-01", timestamp: "2026-01-01T00:00:00Z", score: 90, hidden: true } : { id: "w", day: "2026-01-01", start_datetime: "2026-01-01T10:00:00Z", end_datetime: "2026-01-01T11:00:00Z", activity: "running", hidden: true }], next_token: null }));
    const client = new OuraRestTransport(session() as never, { fetch: fetch as typeof fetch });
    await expect(client.listSleep(window)).resolves.toMatchObject({ complete: true, records: [{ id: "sleep-1", type: "long_sleep" }] });
    await expect(client.listReadiness(window)).resolves.toMatchObject({ complete: true, records: [{ id: "r", score: 90 }] });
    await expect(client.listWorkouts(window)).resolves.toMatchObject({ complete: true, records: [{ id: "w", activity: "running" }] });
    for (const [url] of fetch.mock.calls) { expect(url.origin).toBe("https://api.ouraring.com"); expect(url.searchParams.get("start_date")).toBe("2026-01-01"); expect(url.searchParams.get("end_date")).toBe("2026-01-02"); expect(url.searchParams.has("start")).toBe(false); }
    expect(fetch.mock.calls.map(([url]) => url.pathname)).toEqual(["/v2/usercollection/sleep", "/v2/usercollection/daily_readiness", "/v2/usercollection/workout"]);
    const output = await client.listSleep(window); expect(JSON.stringify(output)).not.toContain("ignored");
  });
  it("projects invalid optional values with field issues, discards invalid required and out-of-window records", async () => {
    const fetch = vi.fn(async () => response({ data: [{ ...sleep, type: 4, total_sleep_duration: "bad" }, { ...sleep, id: "bad", bedtime_start: null }, { ...sleep, id: "outside", day: "2026-01-03" }], next_token: null }));
    const got = await new OuraRestTransport(session() as never, { fetch: fetch as typeof fetch }).listSleep(window);
    expect(got.records).toHaveLength(1); expect(got.records[0]).toMatchObject({ type: null, totalSleepDuration: null }); expect(got.complete).toBe(false); expect(got.fieldIssues.map(x => x.field)).toEqual(expect.arrayContaining(["type", "total_sleep_duration", "bedtime_start", "day"]));
  });
  it("paginates, detects repeated continuation tokens, and retains earlier valid pages", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ data: [sleep], next_token: "next" })).mockResolvedValueOnce(response({ data: [{ ...sleep, id: "two" }], next_token: "next" }));
    const got = await new OuraRestTransport(session() as never, { fetch: fetch as typeof fetch }).listSleep(window);
    expect(got).toMatchObject({ complete: false, failure: { code: "INVALID_PROVIDER_DATA" } }); expect(got.records.map(x => x.id)).toEqual(["sleep-1", "two"]); expect(fetch.mock.calls[1][0].searchParams.get("next_token")).toBe("next");
  });
  it("enforces page, record, and decoded byte limits", async () => {
    const tooMany = new OuraRestTransport(session() as never, { fetch: vi.fn(async () => response({ data: [sleep, { ...sleep, id: "two" }], next_token: null })) as typeof fetch, limits: { maxRecordsPerPage: 1 } });
    await expect(tooMany.listSleep(window)).resolves.toMatchObject({ failure: { code: "LIMIT_REACHED" } });
    const bytes = new OuraRestTransport(session() as never, { fetch: vi.fn(async () => response({ data: [sleep], next_token: null, padding: "x".repeat(200) })) as typeof fetch, limits: { maxResponseBytes: 10 } });
    await expect(bytes.listSleep(window)).resolves.toMatchObject({ failure: { code: "INVALID_PROVIDER_DATA" } });
  });
  it("forces one 401 refresh/replay and discards partial data after a second 401", async () => {
    const auth = session(); const fetch = vi.fn().mockResolvedValueOnce(response({}, 401)).mockResolvedValueOnce(response({ data: [sleep], next_token: null }));
    const client = new OuraRestTransport(auth as never, { fetch: fetch as typeof fetch }); await expect(client.listSleep(window)).resolves.toMatchObject({ complete: true, records: [{ id: "sleep-1", type: "long_sleep" }] }); expect(auth.refreshAfterUnauthorized).toHaveBeenCalledWith("canary-token"); expect(fetch).toHaveBeenCalledTimes(2);
    const second = new OuraRestTransport(session() as never, { fetch: vi.fn().mockResolvedValue(response({}, 401)) as typeof fetch }); await expect(second.listSleep(window)).resolves.toEqual({ records: [], complete: false, failure: { code: "AUTHENTICATION_REQUIRED", retryable: false, retryAfterSeconds: null }, fieldIssues: [] });
  });
  it("maps status and known scope failures without leaking provider values", async () => {
    const denied = new OuraRestTransport(session({ getStatus: vi.fn(async () => ({ ok: true, value: { grantedScopes: ["daily"] } })) }) as never, { fetch: vi.fn() as typeof fetch }); await expect(denied.listWorkouts(window)).resolves.toMatchObject({ failure: { code: "PERMISSION_DENIED" } });
    for (const [status, code] of [[403, "PERMISSION_DENIED"], [404, "PROVIDER_CONTRACT_CHANGED"], [400, "INVALID_REQUEST"], [422, "INVALID_REQUEST"], [500, "PROVIDER_UNAVAILABLE"]] as const) await expect(new OuraRestTransport(session() as never, { fetch: vi.fn(async () => response({ detail: "canary-secret" }, status)) as typeof fetch }).listSleep(window)).resolves.toMatchObject({ failure: { code } });
    await expect(new OuraRestTransport(session() as never, { fetch: vi.fn(async () => response({}, 429, { "retry-after": "12" })) as typeof fetch }).listSleep(window)).resolves.toMatchObject({ failure: { code: "RATE_LIMITED", retryAfterSeconds: 12 } });
  });
  it("classifies a slow streamed body as unavailable and cancels its reader", async () => {
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => { cancelled = true; } });
    const client = new OuraRestTransport(session() as never, { fetch: vi.fn(async () => new Response(stream)) as typeof fetch, limits: { attemptTimeoutMs: 10 } });
    await expect(client.listSleep(window)).resolves.toMatchObject({ failure: { code: "PROVIDER_UNAVAILABLE" } });
    expect(cancelled).toBe(true);
  });
  it("returns cancellation, without data, when a body is aborted by its caller", async () => {
    const controller = new AbortController(); let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({ pull: () => new Promise(() => undefined), cancel: () => { cancelled = true; } });
    const client = new OuraRestTransport(session() as never, { fetch: vi.fn(async () => new Response(stream)) as typeof fetch, signal: controller.signal });
    const pending = client.listSleep(window); setTimeout(() => controller.abort(), 5);
    await expect(pending).resolves.toEqual({ records: [], complete: false, failure: { code: "CANCELLED", retryable: true, retryAfterSeconds: null }, fieldIssues: [] });
    expect(cancelled).toBe(true);
  });
  it("bounds stalled status, token acquisition, and 401 recovery by the total deadline", async () => {
    const never = () => new Promise(() => undefined);
    await expect(new OuraRestTransport(session({ getStatus: never }) as never, { limits: { totalDeadlineMs: 10 } }).listSleep(window)).resolves.toMatchObject({ failure: { code: "PROVIDER_UNAVAILABLE" } });
    const ready = { ok: true, value: { grantedScopes: ["daily", "workout"] } };
    await expect(new OuraRestTransport(session({ getStatus: async () => ready, withAccessToken: never }) as never, { limits: { totalDeadlineMs: 10 } }).listSleep(window)).resolves.toMatchObject({ failure: { code: "PROVIDER_UNAVAILABLE" } });
    const auth = session({ getStatus: async () => ready, refreshAfterUnauthorized: never });
    await expect(new OuraRestTransport(auth as never, { fetch: vi.fn(async () => response({}, 401)) as typeof fetch, limits: { totalDeadlineMs: 10 } }).listSleep(window)).resolves.toMatchObject({ failure: { code: "PROVIDER_UNAVAILABLE" } });
  });
  it("does not issue a late bearer request when an expired token acquisition invokes its callback", async () => {
    let callback: ((token: string) => Promise<unknown>) | undefined;
    const fetch = vi.fn(async () => response({ data: [sleep], next_token: null }));
    const auth = session({ withAccessToken: (fn: (token: string) => Promise<unknown>) => { callback = fn; return new Promise(() => undefined); } });
    await expect(new OuraRestTransport(auth as never, { fetch: fetch as typeof fetch, limits: { totalDeadlineMs: 10 } }).listSleep(window)).resolves.toMatchObject({ failure: { code: "PROVIDER_UNAVAILABLE" } });
    await callback?.("late-canary-token");
    expect(fetch).not.toHaveBeenCalled();
  });
});
