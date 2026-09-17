import type { Instant } from "@ahp/health-domain";

export type Result<T, E extends { code: string; retryable: boolean }> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export type AuthError =
  | { code: "CONFIG_INVALID"; retryable: false }
  | { code: "CALLBACK_BIND_FAILED"; retryable: false }
  | { code: "CALLBACK_TIMEOUT"; retryable: true }
  | { code: "ACCESS_DENIED"; retryable: false }
  | { code: "TOKEN_EXCHANGE_FAILED"; retryable: true }
  | { code: "INVALID_TOKEN_RESPONSE"; retryable: false }
  | { code: "CREDENTIAL_STORE_UNAVAILABLE"; retryable: false }
  | { code: "CANCELLED"; retryable: true };

export type AuthStatus = {
  state: "authenticated" | "unauthenticated" | "reauth_required";
  expiresAt: Instant | null;
  grantedScopes: string[] | null;
};

export type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Instant;
  grantedScopes: string[] | null;
  version: 1;
};

export type OuraAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri?: string;
};

export type OAuthToken = {
  accessToken: unknown;
  refreshToken: unknown;
  expiresAt: unknown;
};

/**
 * This narrow boundary keeps OAuth protocol mechanics in the maintained client
 * while keeping callback, state, and replay semantics in application code.
 */
export type OAuthProtocol = {
  authorizationUrl(input: {
    redirectUri: string;
    state: string;
    scopes: readonly string[];
  }): Promise<string>;
  exchangeCode(input: { code: string; redirectUri: string; signal?: AbortSignal }): Promise<OAuthToken>;
};

export type OAuthRefreshProtocol = {
  refreshToken(input: {
    tokenSet: TokenSet;
    signal?: AbortSignal;
  }): Promise<OAuthToken>;
};

export type SessionError =
  | { code: "CONFIG_INVALID"; retryable: false }
  | { code: "CREDENTIAL_STORE_UNAVAILABLE"; retryable: false }
  | { code: "AUTH_BUSY"; retryable: true }
  | { code: "UNAUTHENTICATED"; retryable: false }
  | { code: "REAUTH_REQUIRED"; retryable: false }
  | { code: "CANCELLED"; retryable: true };

export type AuthDependencies = {
  openBrowser(url: string): Promise<void> | void;
  randomBytes(size: number): Uint8Array;
  now(): number;
  tokenSink: { write(tokenSet: TokenSet, signal: AbortSignal): Promise<void> };
  /** A test seam; production defaults to the explicit Oura OAuth client. */
  protocol?: OAuthProtocol;
  /** A test seam; production defaults to a fetch that refuses redirects. */
  tokenFetch?: typeof fetch;
  callbackTimeoutMs?: number;
  /** Bounds token exchange and sink completion after a callback is accepted. */
  postCallbackTimeoutMs?: number;
  signal?: AbortSignal;
};
