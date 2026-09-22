import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  CredentialStoreUnavailableError,
  FileAuthLock,
  MacOSKeychainTokenStore,
  MalformedTokenSetError,
  OuraSession,
  createMacOSKeychainTokenStore,
  type KeychainEntry,
  type TokenSet
} from "../src/auth/index.js";
import type { TokenStore } from "../src/auth/store.js";

const now = Date.parse("2026-09-17T06:00:00.000Z");
const config = { clientId: "client-id", clientSecret: "client-secret" };
function runChild(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const childProcess = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "ignore"] });
    let stdout = "";
    childProcess.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    childProcess.once("error", reject);
    childProcess.once("close", (code) => code === 0 ? resolve(stdout) : reject(new Error("Child lock probe failed.")));
  });
}
const token = (expiresAt = now + 60_000): TokenSet => ({
  accessToken: "canary-access-token", refreshToken: "canary-refresh-token",
  expiresAt: new Date(expiresAt).toISOString(), grantedScopes: ["daily", "workout"], version: 1
});

class MemoryStore implements TokenStore {
  constructor(public value: TokenSet | null) {}
  async read(): Promise<TokenSet | null> { return this.value; }
  async write(value: TokenSet): Promise<void> { this.value = value; }
  async clear(): Promise<void> { this.value = null; }
}

const availableLock = { acquire: async () => ({ release: async () => undefined }) };
const refresher = (value: Partial<{ accessToken: unknown; refreshToken: unknown; expiresAt: unknown }> = {}) => ({
  refreshToken: async () => ({ accessToken: "next-access", refreshToken: "next-refresh", expiresAt: now + 3_600_000, ...value })
});

describe("OuraSession", () => {
  it("force-refreshes a locally valid rejected token once without nested lock acquisition", async () => {
    const store = new MemoryStore(token(now + 3_600_000)); let acquires = 0; let refreshes = 0;
    const session = new OuraSession(config, { store, now: () => now, lock: { acquire: async () => { acquires++; return { release: async () => undefined }; } }, refresher: { refreshToken: async () => { refreshes++; return { accessToken: "forced-next", refreshToken: "next-refresh", expiresAt: now + 3_600_000 }; } } });
    await expect(Promise.all([session.refreshAfterUnauthorized("canary-access-token"), session.refreshAfterUnauthorized("canary-access-token")])).resolves.toEqual([{ ok: true, value: "forced-next" }, { ok: true, value: "forced-next" }]);
    expect(refreshes).toBe(1); expect(acquires).toBe(1); expect(store.value?.accessToken).toBe("forced-next");
  });

  it("uses the newer persisted token after acquiring the lock", async () => {
    const store = new MemoryStore(token(now + 3_600_000)); let refreshes = 0;
    const session = new OuraSession(config, { store, now: () => now, lock: { acquire: async () => { store.value = { ...store.value!, accessToken: "other-process-token" }; return { release: async () => undefined }; } }, refresher: { refreshToken: async () => { refreshes++; throw new Error("must not refresh"); } } });
    await expect(session.refreshAfterUnauthorized("canary-access-token")).resolves.toEqual({ ok: true, value: "other-process-token" }); expect(refreshes).toBe(0);
  });

  it("persists rotation across session instances, preserves grants, and never refreshes status", async () => {
    const store = new MemoryStore(token());
    const first = new OuraSession(config, { store, lock: availableLock, now: () => now, refresher: refresher() });
    expect(await first.getStatus()).toMatchObject({ ok: true, value: { state: "authenticated" } });
    expect(await first.withAccessToken(async (accessToken) => accessToken)).toEqual({ ok: true, value: "next-access" });
    expect(store.value).toMatchObject({ accessToken: "next-access", refreshToken: "next-refresh", grantedScopes: ["daily", "workout"] });
    const second = new OuraSession(config, { store, lock: availableLock, now: () => now });
    expect(await second.getStatus()).toMatchObject({ ok: true, value: { state: "authenticated", grantedScopes: ["daily", "workout"] } });
  });

  it("refreshes at the exact 60-second boundary and shares a single in-process refresh", async () => {
    const store = new MemoryStore(token());
    let resolveRefresh: ((value: { accessToken: string; refreshToken: string; expiresAt: number }) => void) | undefined;
    let refreshes = 0;
    const session = new OuraSession(config, { store, lock: availableLock, now: () => now, refresher: { refreshToken: async () => {
      refreshes++;
      return new Promise((resolve) => { resolveRefresh = resolve; });
    } } });
    const first = session.withAccessToken(async (accessToken) => accessToken);
    const second = session.withAccessToken(async (accessToken) => accessToken);
    await vi.waitFor(() => expect(refreshes).toBe(1));
    resolveRefresh?.({ accessToken: "next-access", refreshToken: "next-refresh", expiresAt: now + 3_600_000 });
    await expect(first).resolves.toEqual({ ok: true, value: "next-access" });
    await expect(second).resolves.toEqual({ ok: true, value: "next-access" });
  });

  it("fails closed for uncertain, malformed, out-of-range, and write-failed rotation", async () => {
    const cases = [
      { protocol: { refreshToken: async () => { throw new Error("canary provider failure"); } } },
      { protocol: { refreshToken: () => { throw new Error("canary provider failure"); } } },
      { protocol: refresher({ accessToken: null }) },
      { protocol: refresher({ refreshToken: "" }) },
      { protocol: refresher({ expiresAt: Number.MAX_VALUE }) }
    ];
    for (const item of cases) {
      const store = new MemoryStore(token());
      const session = new OuraSession(config, { store, lock: availableLock, now: () => now, refresher: item.protocol });
      const result = await session.withAccessToken(async () => "must not run");
      expect(result).toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", retryable: false } });
      expect(JSON.stringify(result)).not.toContain("canary");
      expect(store.value).toBeNull();
    }
    const store = new MemoryStore(token());
    store.write = async () => { throw new Error("canary Keychain denial"); };
    const session = new OuraSession(config, { store, lock: availableLock, now: () => now, refresher: refresher() });
    expect(await session.withAccessToken(async () => "must not run")).toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", retryable: false } });
    expect(store.value).toBeNull();
    expect(await session.withAccessToken(async () => "old token must not be reused")).toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", retryable: false } });
  });

  it("keeps this session invalidated when clearing a failed rotating refresh is denied", async () => {
    const store = new MemoryStore(token());
    store.write = async () => { throw new Error("denied"); };
    store.clear = async () => { throw new Error("denied"); };
    const session = new OuraSession(config, { store, lock: availableLock, now: () => now, refresher: refresher() });
    await expect(session.withAccessToken(async () => "must not run")).resolves.toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", retryable: false } });
    await expect(session.getStatus()).resolves.toEqual({ ok: true, value: { state: "reauth_required", expiresAt: null, grantedScopes: null } });
    await expect(session.withAccessToken(async () => "old token must not run")).resolves.toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", retryable: false } });
  });

  it("maps timeout to reauthentication and cancellation to the distinct cancellation result", async () => {
    vi.useFakeTimers();
    try {
      const timedOutStore = new MemoryStore(token());
      const timedOut = new OuraSession(config, { store: timedOutStore, lock: availableLock, now: () => now, refresher: { refreshToken: async () => new Promise(() => undefined) } });
      const pending = timedOut.withAccessToken(async () => "must not run");
      await vi.advanceTimersByTimeAsync(15_000);
      await expect(pending).resolves.toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", retryable: false } });
      expect(timedOutStore.value).toBeNull();
    } finally { vi.useRealTimers(); }

    const controller = new AbortController();
    const store = new MemoryStore(token());
    let releases = 0; let refreshStarted = 0;
    const session = new OuraSession(config, {
      store, now: () => now, signal: controller.signal,
      lock: { acquire: async () => ({ release: async () => { releases++; } }) },
      refresher: { refreshToken: async ({ signal }) => {
        refreshStarted++;
        return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")), { once: true }));
      } }
    });
    const pending = session.withAccessToken(async () => "must not run");
    await vi.waitFor(() => expect(refreshStarted).toBe(1));
    controller.abort();
    await expect(pending).resolves.toEqual({ ok: false, error: { code: "CANCELLED", retryable: true } });
    expect(store.value).toBeNull();
    expect(releases).toBe(1);
  });

  it("returns every session error with its exact code and retryability", async () => {
    const invalid = new OuraSession({ clientId: "", clientSecret: "secret" }, { store: new MemoryStore(null), lock: availableLock });
    await expect(invalid.getStatus()).resolves.toEqual({ ok: false, error: { code: "CONFIG_INVALID", retryable: false } });
    const unavailableStore: TokenStore = { read: async () => { throw new CredentialStoreUnavailableError(); }, write: async () => undefined, clear: async () => undefined };
    await expect(new OuraSession(config, { store: unavailableStore, lock: availableLock }).getStatus()).resolves.toEqual({ ok: false, error: { code: "CREDENTIAL_STORE_UNAVAILABLE", retryable: false } });
    await expect(new OuraSession(config, { store: new MemoryStore(token()), lock: { acquire: async () => null }, now: () => now, refresher: refresher() }).withAccessToken(async () => "must not run")).resolves.toEqual({ ok: false, error: { code: "AUTH_BUSY", retryable: true } });
    await expect(new OuraSession(config, { store: new MemoryStore(null), lock: availableLock }).withAccessToken(async () => "must not run")).resolves.toEqual({ ok: false, error: { code: "UNAUTHENTICATED", retryable: false } });
    const malformed: TokenStore = { read: async () => { throw new MalformedTokenSetError(); }, write: async () => undefined, clear: async () => undefined };
    await expect(new OuraSession(config, { store: malformed, lock: availableLock }).withAccessToken(async () => "must not run")).resolves.toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", retryable: false } });
    const cancelled = new AbortController(); cancelled.abort();
    await expect(new OuraSession(config, { store: new MemoryStore(token()), lock: availableLock, signal: cancelled.signal }).withAccessToken(async () => "must not run")).resolves.toEqual({ ok: false, error: { code: "CANCELLED", retryable: true } });
  });

  it("fails closed for invalid stored expiry and clears local storage on logout under the lock", async () => {
    const invalidExpiry = { ...token(now + 3_600_000), expiresAt: "+275760-09-13T00:00:00.001Z" } as TokenSet;
    const invalid = new OuraSession(config, { store: new MemoryStore(invalidExpiry), lock: availableLock, now: () => now });
    await expect(invalid.getStatus()).resolves.toEqual({ ok: true, value: { state: "reauth_required", expiresAt: null, grantedScopes: null } });
    await expect(invalid.withAccessToken(async () => "must not run")).resolves.toEqual({ ok: false, error: { code: "REAUTH_REQUIRED", retryable: false } });
    const store = new MemoryStore(token(now + 3_600_000)); let releases = 0;
    await expect(new OuraSession(config, { store, lock: { acquire: async () => ({ release: async () => { releases++; } }) } }).logout()).resolves.toEqual({ ok: true, value: { state: "unauthenticated", expiresAt: null, grantedScopes: null } });
    expect(store.value).toBeNull(); expect(releases).toBe(1);
  });
});

describe("Keychain token store", () => {
  it("uses one sanitized Keychain item, accepts the native null absence form, and treats denial and unsupported platforms as unavailable", async () => {
    let persisted: string | null | undefined;
    const entry: KeychainEntry = { getPassword: async () => persisted, setPassword: async (value) => { persisted = value; }, deleteCredential: async () => { persisted = null; return true; } };
    const store = await createMacOSKeychainTokenStore("client-id", { platform: "darwin", createEntry: (_service, account) => {
      expect(account).toBe(createHash("sha256").update("client-id").digest("hex")); expect(account).not.toContain("client-id"); return entry;
    } });
    await store.write(token(now + 3_600_000)); expect(persisted).toContain("canary-access-token");
    await expect(store.read()).resolves.toMatchObject({ version: 1 }); await store.clear(); await expect(store.read()).resolves.toBeNull();
    await expect(new OuraSession(config, { store, lock: availableLock }).getStatus()).resolves.toEqual({
      ok: true, value: { state: "unauthenticated", expiresAt: null, grantedScopes: null }
    });
    const denied = new MacOSKeychainTokenStore({ ...entry, getPassword: async () => { throw new Error("canary Keychain diagnostic"); } });
    await expect(denied.read()).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    const writeDenied = new MacOSKeychainTokenStore({ ...entry, setPassword: async () => { throw new Error("canary Keychain diagnostic"); } });
    await expect(writeDenied.write(token())).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    const deleteDenied = new MacOSKeychainTokenStore({ ...entry, deleteCredential: async () => { throw new Error("canary Keychain diagnostic"); } });
    await expect(deleteDenied.clear()).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    const malformed = new MacOSKeychainTokenStore({ ...entry, getPassword: async () => "{not json" });
    await expect(malformed.read()).rejects.toBeInstanceOf(MalformedTokenSetError);
    const undeleted = new MacOSKeychainTokenStore({
      ...entry,
      getPassword: async () => JSON.stringify(token(now + 3_600_000)),
      deleteCredential: async () => true
    });
    await expect(undeleted.clear()).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    let sawAbortSignal = false;
    const cancellation = new MacOSKeychainTokenStore({ ...entry, setPassword: async (_value, signal) => new Promise<void>((_resolve, reject) => {
      sawAbortSignal = signal !== undefined;
      signal?.addEventListener("abort", () => reject(new DOMException("", "AbortError")), { once: true });
    }) });
    const controller = new AbortController();
    const pending = cancellation.write(token(), controller.signal);
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
    expect(sawAbortSignal).toBe(true);
    await expect(createMacOSKeychainTokenStore("client-id", { platform: "linux" })).rejects.toBeInstanceOf(CredentialStoreUnavailableError);
  });
});

describe("FileAuthLock", () => {
  it("uses private metadata and a separate process cannot steal or remove a held lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "ahp-lock-test-"));
    const clientId = "lock-client";
    const path = join(directory, `oura-auth-${createHash("sha256").update(clientId).digest("hex")}.lock`);
    try {
      const held = await new FileAuthLock(clientId, directory).acquire(); expect(held).not.toBeNull();
      expect((await stat(directory)).mode & 0o777).toBe(0o700); expect((await stat(path)).mode & 0o777).toBe(0o700);
      const [ownerFile] = await readdir(path);
      expect(ownerFile).toMatch(/^owner-[0-9a-f-]+\.json$/);
      expect((await stat(join(path, ownerFile!))).mode & 0o777).toBe(0o600);
      expect(await readFile(join(path, ownerFile!), "utf8")).toMatch(/^\{"pid":\d+,"startedAt":\d+\}$/);
      expect(await new FileAuthLock(clientId, directory).acquire()).toBeNull();
      const result = await runChild(["--input-type=module", "--eval", "import { mkdir } from 'node:fs/promises'; try { await mkdir(process.argv[1]); process.stdout.write('acquired') } catch (error) { process.stdout.write(error.code) }", path]);
      expect(result).toBe("EEXIST");
      await held?.release(); await held?.release();
      const next = await new FileAuthLock(clientId, directory).acquire(); expect(next).not.toBeNull(); await next?.release();
      const staleMetadata = "{\"pid\":999999,\"startedAt\":0}";
      await mkdir(path, { mode: 0o700 });
      await writeFile(join(path, "owner.json"), staleMetadata, { mode: 0o600 });
      expect(await new FileAuthLock(clientId, directory).acquire()).toBeNull();
      expect(await readFile(join(path, "owner.json"), "utf8")).toBe(staleMetadata);
      await rm(path, { recursive: true, force: true });
      const oldOwner = await new FileAuthLock(clientId, directory).acquire();
      expect(oldOwner).not.toBeNull();
      await rm(path, { recursive: true, force: true });
      const replacement = await new FileAuthLock(clientId, directory).acquire();
      expect(replacement).not.toBeNull();
      await oldOwner?.release();
      await expect(stat(path)).resolves.toBeDefined();
      await replacement?.release();
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});
