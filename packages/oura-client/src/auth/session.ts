import { createOuraRefreshProtocol } from "./flow.js";
import { validateOuraAuthConfig } from "./config.js";
import { CredentialStoreUnavailableError } from "./keychain-store.js";
import { MalformedTokenSetError, type TokenStore } from "./store.js";
import type { AuthLock } from "./lock.js";
import type { AuthStatus, OAuthRefreshProtocol, OAuthToken, OuraAuthConfig, Result, SessionError, TokenSet } from "./types.js";

const REFRESH_SKEW_MS = 60_000;
const REFRESH_TIMEOUT_MS = 15_000;

type SessionDependencies = {
  store: TokenStore;
  lock: { acquire(): Promise<AuthLock | null> };
  now?: () => number;
  refresher?: OAuthRefreshProtocol;
  tokenFetch?: typeof fetch;
  /** Composition roots may cancel an operation; this never exposes token state. */
  signal?: AbortSignal;
};

function error<C extends SessionError["code"]>(code: C): Extract<SessionError, { code: C }> {
  return { code, retryable: code === "AUTH_BUSY" || code === "CANCELLED" } as Extract<SessionError, { code: C }>;
}

function safeDateMilliseconds(value: string | number): number | null {
  const milliseconds = new Date(value).getTime();
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function status(tokens: TokenSet | null, now: number): AuthStatus {
  if (tokens === null) return { state: "unauthenticated", expiresAt: null, grantedScopes: null };
  const expiresAt = safeDateMilliseconds(tokens.expiresAt);
  if (expiresAt === null || expiresAt <= now) return { state: "reauth_required", expiresAt: null, grantedScopes: null };
  return { state: "authenticated", expiresAt: tokens.expiresAt, grantedScopes: tokens.grantedScopes === null ? null : [...tokens.grantedScopes] };
}

type BoundedRefresh<T> =
  | { kind: "success"; value: T }
  | { kind: "failed" }
  | { kind: "cancelled" }
  | { kind: "timeout" };

function boundedRefresh(
  refresher: OAuthRefreshProtocol,
  tokenSet: TokenSet,
  externalSignal: AbortSignal | undefined
): Promise<BoundedRefresh<OAuthToken>> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: BoundedRefresh<OAuthToken>): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
      if (result.kind === "cancelled" || result.kind === "timeout") controller.abort();
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: "cancelled" });
    if (externalSignal?.aborted) return onAbort();
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => finish({ kind: "timeout" }), REFRESH_TIMEOUT_MS);
    Promise.resolve().then(() => refresher.refreshToken({ tokenSet, signal: controller.signal })).then(
      (value) => finish({ kind: "success", value }),
      () => finish({ kind: "failed" })
    );
  });
}

export class OuraSession {
  private refreshInFlight: Promise<Result<TokenSet, SessionError>> | null = null;
  /** A rotating refresh may have consumed the old token even if clearing fails. */
  private reauthRequired = false;
  private readonly now: () => number;
  private readonly refresher: OAuthRefreshProtocol;
  private readonly configValid: boolean;

  constructor(config: OuraAuthConfig, private readonly dependencies: SessionDependencies) {
    this.configValid = validateOuraAuthConfig(config) !== null;
    this.now = dependencies.now ?? Date.now;
    this.refresher = dependencies.refresher ?? createOuraRefreshProtocol(config, dependencies.tokenFetch);
  }

  async getStatus(): Promise<Result<AuthStatus, SessionError>> {
    if (!this.configValid) return { ok: false, error: error("CONFIG_INVALID") };
    if (this.dependencies.signal?.aborted) return { ok: false, error: error("CANCELLED") };
    if (this.reauthRequired) return { ok: true, value: { state: "reauth_required", expiresAt: null, grantedScopes: null } };
    try { return { ok: true, value: status(await this.dependencies.store.read(), this.now()) }; }
    catch (cause) {
      if (cause instanceof MalformedTokenSetError) return { ok: true, value: { state: "reauth_required", expiresAt: null, grantedScopes: null } };
      return { ok: false, error: error("CREDENTIAL_STORE_UNAVAILABLE") };
    }
  }

  async logout(): Promise<Result<AuthStatus, SessionError>> {
    if (!this.configValid) return { ok: false, error: error("CONFIG_INVALID") };
    if (this.dependencies.signal?.aborted) return { ok: false, error: error("CANCELLED") };
    try {
      const lock = await this.dependencies.lock.acquire();
      if (lock === null) return { ok: false, error: error("AUTH_BUSY") };
      try {
        if (this.dependencies.signal?.aborted) return { ok: false, error: error("CANCELLED") };
        await this.dependencies.store.clear();
        this.reauthRequired = false;
      } finally { await lock.release().catch(() => undefined); }
      return { ok: true, value: { state: "unauthenticated", expiresAt: null, grantedScopes: null } };
    } catch { return { ok: false, error: error("CREDENTIAL_STORE_UNAVAILABLE") }; }
  }

  async withAccessToken<T>(fn: (accessToken: string) => Promise<T>): Promise<Result<T, SessionError>> {
    if (!this.configValid) return { ok: false, error: error("CONFIG_INVALID") };
    if (this.dependencies.signal?.aborted) return { ok: false, error: error("CANCELLED") };
    const refreshed = await this.currentTokens();
    if (!refreshed.ok) return refreshed;
    try { return { ok: true, value: await fn(refreshed.value.accessToken) }; }
    catch { throw new Error("Provider composition callback failed."); }
  }

  private async currentTokens(): Promise<Result<TokenSet, SessionError>> {
    if (this.reauthRequired) return { ok: false, error: error("REAUTH_REQUIRED") };
    let tokens: TokenSet | null;
    try { tokens = await this.dependencies.store.read(); }
    catch (cause) {
      if (cause instanceof MalformedTokenSetError) return { ok: false, error: error("REAUTH_REQUIRED") };
      return { ok: false, error: error("CREDENTIAL_STORE_UNAVAILABLE") };
    }
    if (tokens === null) return { ok: false, error: error("UNAUTHENTICATED") };
    const expiresAt = safeDateMilliseconds(tokens.expiresAt);
    if (expiresAt === null) return { ok: false, error: error("REAUTH_REQUIRED") };
    if (expiresAt > this.now() + REFRESH_SKEW_MS) return { ok: true, value: tokens };
    if (this.refreshInFlight === null) this.refreshInFlight = this.refresh(tokens).finally(() => { this.refreshInFlight = null; });
    return this.refreshInFlight;
  }

  private async refresh(previous: TokenSet): Promise<Result<TokenSet, SessionError>> {
    let lock: AuthLock | null;
    try { lock = await this.dependencies.lock.acquire(); }
    catch { return { ok: false, error: error("CREDENTIAL_STORE_UNAVAILABLE") }; }
    if (lock === null) return { ok: false, error: error("AUTH_BUSY") };
    try {
      if (this.dependencies.signal?.aborted) return { ok: false, error: error("CANCELLED") };
      let current: TokenSet | null;
      try { current = await this.dependencies.store.read(); }
      catch (cause) {
        return { ok: false, error: error(cause instanceof MalformedTokenSetError ? "REAUTH_REQUIRED" : "CREDENTIAL_STORE_UNAVAILABLE") };
      }
      if (current === null) return { ok: false, error: error("UNAUTHENTICATED") };
      const currentExpiry = safeDateMilliseconds(current.expiresAt);
      if (currentExpiry === null) return { ok: false, error: error("REAUTH_REQUIRED") };
      if (currentExpiry > this.now() + REFRESH_SKEW_MS) return { ok: true, value: current };
      const refreshed = await boundedRefresh(this.refresher, current, this.dependencies.signal);
      if (refreshed.kind === "cancelled") {
        await this.clearAfterRefreshFailure();
        return { ok: false, error: error("CANCELLED") };
      }
      const token = refreshed.kind === "success" ? refreshed.value : null;
      const tokenExpiry = token?.expiresAt;
      const expiry = typeof tokenExpiry === "number" ? safeDateMilliseconds(tokenExpiry) : null;
      if (token === null || typeof token.accessToken !== "string" || !token.accessToken || typeof token.refreshToken !== "string" || !token.refreshToken || expiry === null || expiry <= this.now()) {
        await this.clearAfterRefreshFailure();
        return { ok: false, error: error("REAUTH_REQUIRED") };
      }
      const next: TokenSet = {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: new Date(expiry).toISOString(),
        grantedScopes: current.grantedScopes === null ? null : [...current.grantedScopes],
        version: 1
      };
      try { await this.dependencies.store.write(next); }
      catch { await this.clearAfterRefreshFailure(); return { ok: false, error: error("REAUTH_REQUIRED") }; }
      return { ok: true, value: next };
    } finally { await lock.release().catch(() => undefined); }
  }

  private async clearAfterRefreshFailure(): Promise<void> {
    this.reauthRequired = true;
    await this.dependencies.store.clear().catch(() => undefined);
  }
}

export { REFRESH_SKEW_MS };
