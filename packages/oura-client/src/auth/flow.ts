import { OAuth2Client } from "@badgateway/oauth2-client";
import { Buffer } from "node:buffer";
import { randomBytes as systemRandomBytes } from "node:crypto";
import { InstantSchema, type Instant } from "@ahp/health-domain";

import {
  CALLBACK_TIMEOUT_MS,
  OURA_AUTHORIZATION_ENDPOINT,
  OURA_SCOPES,
  OURA_TOKEN_ENDPOINT,
  STATE_BYTES,
  validateOuraAuthConfig
} from "./config.js";
import { startCallbackListener } from "./callback.js";
import type {
  AuthDependencies,
  AuthError,
  AuthStatus,
  OAuthProtocol,
  OAuthToken,
  OuraAuthConfig,
  Result,
  TokenSet
} from "./types.js";

const ERROR_MESSAGES: Record<AuthError["code"], string> = {
  CONFIG_INVALID: "OAuth configuration is invalid.",
  CALLBACK_BIND_FAILED: "The OAuth callback listener could not start.",
  CALLBACK_TIMEOUT: "The OAuth callback timed out.",
  ACCESS_DENIED: "OAuth access was denied.",
  TOKEN_EXCHANGE_FAILED: "The OAuth token exchange failed.",
  INVALID_TOKEN_RESPONSE: "The OAuth token response was invalid.",
  CREDENTIAL_STORE_UNAVAILABLE: "Credential storage is unavailable.",
  CANCELLED: "OAuth login was cancelled."
};

const POST_CALLBACK_TIMEOUT_MS = CALLBACK_TIMEOUT_MS;

export function authErrorMessage(code: AuthError["code"]): string {
  return ERROR_MESSAGES[code];
}

function authError<C extends AuthError["code"]>(code: C): Extract<AuthError, { code: C }> {
  const retryable = code === "CALLBACK_TIMEOUT" || code === "TOKEN_EXCHANGE_FAILED" || code === "CANCELLED";
  return { code, retryable } as Extract<AuthError, { code: C }>;
}

function base64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

class InvalidTokenResponseError extends Error {
  constructor() {
    super("Invalid OAuth token response.");
  }
}

class TokenRedirectError extends Error {
  constructor() {
    super("OAuth token endpoint redirect refused.");
  }
}

function isValidTokenResponse(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const response = value as Record<string, unknown>;
  return (
    typeof response.access_token === "string" &&
    response.access_token.length > 0 &&
    typeof response.refresh_token === "string" &&
    response.refresh_token.length > 0 &&
    typeof response.expires_in === "number" &&
    Number.isFinite(response.expires_in) &&
    response.expires_in > 0 &&
    typeof response.token_type === "string" &&
    response.token_type.toLowerCase() === "bearer"
  );
}

function tokenFetchBoundary(tokenFetch: typeof fetch, signal?: AbortSignal): typeof fetch {
  return async (input, init) => {
    if (signal?.aborted) throw new DOMException("OAuth login was cancelled.", "AbortError");
    const response = await tokenFetch(input, {
      ...init,
      redirect: "manual",
      ...(signal === undefined ? {} : { signal })
    });
    if (response.status >= 300 && response.status < 400) {
      throw new TokenRedirectError();
    }
    if (response.ok) {
      let body: unknown;
      try {
        body = await response.clone().json();
      } catch {
        throw new InvalidTokenResponseError();
      }
      if (!isValidTokenResponse(body)) throw new InvalidTokenResponseError();
    }
    return response;
  };
}

/**
 * Protocol encoding and code exchange live in the reviewed library. Endpoints
 * are deliberately explicit: no discovery endpoint, server metadata, or issuer
 * value is configured for Oura.
 */
export function createOuraOAuthProtocol(
  config: { clientId: string; clientSecret: string },
  tokenFetch: typeof fetch = fetch
): OAuthProtocol {
  const client = (signal?: AbortSignal) => new OAuth2Client({
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    authorizationEndpoint: OURA_AUTHORIZATION_ENDPOINT,
    tokenEndpoint: OURA_TOKEN_ENDPOINT,
    authenticationMethod: "client_secret_post",
    fetch: tokenFetchBoundary(tokenFetch, signal)
  });

  return {
    authorizationUrl: (input) =>
      client().authorizationCode.getAuthorizeUri({
        redirectUri: input.redirectUri,
        state: input.state,
        scope: [...input.scopes]
      }),
    async exchangeCode(input): Promise<OAuthToken> {
      const token = await client(input.signal).authorizationCode.getToken({
        code: input.code,
        redirectUri: input.redirectUri
      });
      return {
        accessToken: token.accessToken,
        refreshToken: token.refreshToken,
        expiresAt: token.expiresAt
      };
    }
  };
}

function validTokenSet(
  token: OAuthToken,
  now: number,
  grantedScopes: string[] | null
): TokenSet | null {
  if (
    typeof token.accessToken !== "string" ||
    token.accessToken.length === 0 ||
    typeof token.refreshToken !== "string" ||
    token.refreshToken.length === 0 ||
    typeof token.expiresAt !== "number" ||
    !Number.isFinite(token.expiresAt) ||
    token.expiresAt <= now
  ) {
    return null;
  }

  const expiry = new Date(token.expiresAt);
  if (Number.isNaN(expiry.getTime())) return null;
  const expiresAt = expiry.toISOString();
  if (!InstantSchema.safeParse(expiresAt).success) return null;
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: expiresAt as Instant,
    grantedScopes: grantedScopes === null ? null : [...grantedScopes],
    version: 1
  };
}

type BoundedResult<T> =
  | { kind: "success"; value: T }
  | { kind: "failed"; error: unknown }
  | { kind: "cancelled" }
  | { kind: "timeout" };

function runBounded<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  externalSignal: AbortSignal | undefined,
  timeoutMs: number
): Promise<BoundedResult<T>> {
  return new Promise((resolve) => {
    const controller = new AbortController();
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: BoundedResult<T>): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      externalSignal?.removeEventListener("abort", onAbort);
      if (result.kind === "cancelled" || result.kind === "timeout") controller.abort();
      resolve(result);
    };
    const onAbort = (): void => finish({ kind: "cancelled" });
    if (externalSignal?.aborted) {
      onAbort();
      return;
    }
    externalSignal?.addEventListener("abort", onAbort, { once: true });
    timeout = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
    try {
      operation(controller.signal).then(
        (value) => finish({ kind: "success", value }),
        (error: unknown) => finish({ kind: "failed", error })
      );
    } catch (error) {
      finish({ kind: "failed", error });
    }
  });
}

function waitForAttempt(
  callback: Promise<unknown>,
  browserUrl: string,
  dependencies: AuthDependencies,
  timeoutMs: number
): Promise<"callback" | "cancelled" | "timeout"> {
  return new Promise((resolve) => {
    let settled = false;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: "callback" | "cancelled" | "timeout"): void => {
      if (settled) return;
      settled = true;
      if (timeout !== undefined) clearTimeout(timeout);
      dependencies.signal?.removeEventListener("abort", abort);
      resolve(result);
    };
    const abort = (): void => finish("cancelled");
    timeout = setTimeout(() => finish("timeout"), timeoutMs);
    dependencies.signal?.addEventListener("abort", abort, { once: true });
    callback.then(
      () => finish("callback"),
      () => finish("cancelled")
    );
    Promise.resolve()
      .then(() => dependencies.openBrowser(browserUrl))
      .catch(() => finish("cancelled"));
    if (dependencies.signal?.aborted) abort();
  });
}

export async function login(
  config: OuraAuthConfig,
  dependencies: AuthDependencies
): Promise<Result<AuthStatus, AuthError>> {
  const validated = validateOuraAuthConfig(config);
  if (validated === null || !Number.isFinite(dependencies.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS) ||
      (dependencies.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS) <= 0 ||
      !Number.isFinite(dependencies.postCallbackTimeoutMs ?? POST_CALLBACK_TIMEOUT_MS) ||
      (dependencies.postCallbackTimeoutMs ?? POST_CALLBACK_TIMEOUT_MS) <= 0) {
    return { ok: false, error: authError("CONFIG_INVALID") };
  }
  if (dependencies.signal?.aborted) {
    return { ok: false, error: authError("CANCELLED") };
  }

  let random: Uint8Array;
  try {
    random = dependencies.randomBytes(STATE_BYTES);
  } catch {
    return { ok: false, error: authError("CONFIG_INVALID") };
  }
  if (!(random instanceof Uint8Array) || random.byteLength < STATE_BYTES) {
    return { ok: false, error: authError("CONFIG_INVALID") };
  }
  const state = base64Url(random);

  let attempt;
  try {
    attempt = await startCallbackListener(validated.redirectUri, state);
  } catch {
    return { ok: false, error: authError("CALLBACK_BIND_FAILED") };
  }

  try {
    let protocol: OAuthProtocol;
    let authorizationUrl: string;
    try {
      protocol = dependencies.protocol ?? createOuraOAuthProtocol(validated, dependencies.tokenFetch);
      authorizationUrl = await protocol.authorizationUrl({
        redirectUri: validated.redirectUri,
        state,
        scopes: OURA_SCOPES
      });
    } catch {
      return { ok: false, error: authError("CONFIG_INVALID") };
    }

    const waiting = await waitForAttempt(
      attempt.wait(),
      authorizationUrl,
      dependencies,
      dependencies.callbackTimeoutMs ?? CALLBACK_TIMEOUT_MS
    );
    if (waiting === "cancelled") {
      return { ok: false, error: authError("CANCELLED") };
    }
    if (waiting === "timeout") {
      return { ok: false, error: authError("CALLBACK_TIMEOUT") };
    }

    const callback = await attempt.wait();
    if (callback.kind === "denied") {
      return { ok: false, error: authError("ACCESS_DENIED") };
    }

    const exchange = await runBounded(
      (signal) => protocol.exchangeCode({
        code: callback.code,
        redirectUri: validated.redirectUri,
        signal
      }),
      dependencies.signal,
      dependencies.postCallbackTimeoutMs ?? POST_CALLBACK_TIMEOUT_MS
    );
    if (exchange.kind === "cancelled") {
      return { ok: false, error: authError("CANCELLED") };
    }
    if (exchange.kind === "timeout") {
      return { ok: false, error: authError("TOKEN_EXCHANGE_FAILED") };
    }
    if (exchange.kind === "failed") {
      if (exchange.error instanceof InvalidTokenResponseError) {
        return { ok: false, error: authError("INVALID_TOKEN_RESPONSE") };
      }
      return { ok: false, error: authError("TOKEN_EXCHANGE_FAILED") };
    }
    const tokenSet = validTokenSet(exchange.value, dependencies.now(), callback.grantedScopes);
    if (tokenSet === null) {
      return { ok: false, error: authError("INVALID_TOKEN_RESPONSE") };
    }
    const persistence = await runBounded(
      (signal) => dependencies.tokenSink.write(tokenSet, signal),
      dependencies.signal,
      dependencies.postCallbackTimeoutMs ?? POST_CALLBACK_TIMEOUT_MS
    );
    if (persistence.kind === "cancelled") {
      return { ok: false, error: authError("CANCELLED") };
    }
    if (persistence.kind === "timeout" || persistence.kind === "failed") {
      return { ok: false, error: authError("CREDENTIAL_STORE_UNAVAILABLE") };
    }
    return {
      ok: true,
      value: {
        state: "authenticated",
        expiresAt: tokenSet.expiresAt,
        grantedScopes: tokenSet.grantedScopes === null ? null : [...tokenSet.grantedScopes]
      }
    };
  } finally {
    await attempt.close();
  }
}

export const systemAuthDependencies = {
  randomBytes: (size: number): Uint8Array => systemRandomBytes(size),
  now: (): number => Date.now()
};
