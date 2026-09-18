import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { Buffer } from "node:buffer";
import { describe, expect, it, vi } from "vitest";

import {
  OURA_AUTHORIZATION_ENDPOINT,
  OURA_TOKEN_ENDPOINT,
  authErrorMessage,
  createOuraOAuthProtocol,
  login,
  validateOuraAuthConfig,
  type AuthDependencies,
  type OAuthProtocol,
  type OAuthToken,
  type TokenSet
} from "../src/auth/index.js";
import * as publicAuth from "../src/auth/index.js";

const now = 1_800_000_000_000;
const secretCanary = "CANARY_CLIENT_SECRET_DO_NOT_LEAK";
const state = Buffer.alloc(32, 9).toString("base64url");

async function unusedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen({ host: "127.0.0.1", port: 0 }, resolve));
  const address = server.address() as AddressInfo;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return address.port;
}

async function expectPortAvailable(port: number): Promise<void> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port }, resolve);
  });
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

async function sendCallback(port: number, path: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const pending = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}` } }, (response) => {
      response.resume();
      response.on("end", resolve);
    });
    pending.on("error", reject);
    pending.end();
  });
}

function token(expiresAt = now + 60_000): OAuthToken {
  return { accessToken: "access-token", refreshToken: "refresh-token", expiresAt };
}

function dependencies(overrides: Partial<AuthDependencies> = {}): AuthDependencies {
  return {
    openBrowser: () => undefined,
    randomBytes: () => Buffer.alloc(32, 9),
    now: () => now,
    tokenSink: { write: async () => undefined },
    ...overrides
  };
}

function protocol(overrides: Partial<OAuthProtocol> = {}): OAuthProtocol {
  return {
    authorizationUrl: async ({ state: receivedState }) => `https://example.test/authorize?state=${receivedState}`,
    exchangeCode: async () => token(),
    ...overrides
  };
}

describe("Oura OAuth protocol boundary", () => {
  it("uses documented explicit endpoints, form-body credentials, no PKCE, and manual redirects", async () => {
    const calls: Array<{ input: RequestInfo | URL; init: RequestInit | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      calls.push({ input, init });
      return new Response(JSON.stringify({
        access_token: "access-token",
        refresh_token: "refresh-token",
        expires_in: 60,
        token_type: "bearer"
      }), { headers: { "content-type": "application/json" } });
    };
    const oauth = createOuraOAuthProtocol({ clientId: "client id", clientSecret: secretCanary }, fakeFetch);
    const authorizationUrl = new URL(await oauth.authorizationUrl({
      redirectUri: "http://127.0.0.1:8788/callback",
      state,
      scopes: ["daily", "workout"]
    }));
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(OURA_AUTHORIZATION_ENDPOINT);
    expect(Object.fromEntries(authorizationUrl.searchParams)).toEqual({
      client_id: "client id",
      response_type: "code",
      redirect_uri: "http://127.0.0.1:8788/callback",
      scope: "daily workout",
      state
    });
    expect(authorizationUrl.searchParams.has("code_challenge")).toBe(false);

    const received = await oauth.exchangeCode({ code: "authorization-code", redirectUri: "http://127.0.0.1:8788/callback" });
    expect(received.accessToken).toBe("access-token");
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(String(call.input)).toBe(OURA_TOKEN_ENDPOINT);
    expect(call.init?.method).toBe("POST");
    expect(call.init?.redirect).toBe("manual");
    expect(call.init?.headers).toMatchObject({ "Content-Type": "application/x-www-form-urlencoded" });
    expect(new URLSearchParams(String(call.init?.body))).toEqual(new URLSearchParams({
      grant_type: "authorization_code",
      code: "authorization-code",
      redirect_uri: "http://127.0.0.1:8788/callback",
      client_id: "client id",
      client_secret: secretCanary
    }));
  });

  it("refuses redirects before the OAuth library can follow them", async () => {
    let redirectMode: RequestRedirect | undefined;
    const oauth = createOuraOAuthProtocol({ clientId: "client", clientSecret: "secret" }, async (_input, init) => {
      redirectMode = init?.redirect;
      return new Response(null, { status: 302, headers: { location: "https://other.test/token" } });
    });
    await expect(oauth.exchangeCode({ code: "code", redirectUri: "http://127.0.0.1:8788/callback" })).rejects.toThrow("redirect");
    expect(redirectMode).toBe("manual");
  });
});

describe("isolated authorization-code login", () => {
  it("writes exactly one validated non-secret token set after a matching callback, even before browser opening resolves", async () => {
    const port = await unusedPort();
    const writes: TokenSet[] = [];
    let authorizationInput: Parameters<OAuthProtocol["authorizationUrl"]>[0] | undefined;
    let exchangedCode: string | undefined;
    let opened: (() => void) | undefined;
    const openStarted = new Promise<void>((resolve) => { opened = resolve; });
    const resultPromise = login({ clientId: "client", clientSecret: secretCanary, redirectUri: `http://127.0.0.1:${port}/callback` }, dependencies({
      openBrowser: () => {
        opened?.();
        return new Promise<void>(() => undefined);
      },
      protocol: protocol({
        authorizationUrl: async (input) => {
          authorizationInput = input;
          return `https://example.test/authorize?state=${input.state}`;
        },
        exchangeCode: async ({ code }) => {
          exchangedCode = code;
          return token();
        }
      }),
      tokenSink: { write: async (value) => { writes.push(value); } }
    }));
    await openStarted;
    await sendCallback(port, `/callback?code=one-time-code&scope=daily%20workout&state=${state}`);
    const result = await resultPromise;

    expect(authorizationInput).toEqual({ redirectUri: `http://127.0.0.1:${port}/callback`, state, scopes: ["daily", "workout"] });
    expect(exchangedCode).toBe("one-time-code");
    expect(writes).toEqual([{
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(now + 60_000).toISOString(),
      grantedScopes: ["daily", "workout"],
      version: 1
    }]);
    expect(result).toEqual({ ok: true, value: { state: "authenticated", expiresAt: new Date(now + 60_000).toISOString(), grantedScopes: ["daily", "workout"] } });
    expect(JSON.stringify({ result, writes })).not.toContain(secretCanary);
    expect(JSON.stringify({ result, writes })).not.toContain("one-time-code");
    await expectPortAvailable(port);
  });

  it("preserves an absent callback scope as unknown instead of substituting requested scopes", async () => {
    const port = await unusedPort();
    let opened: (() => void) | undefined;
    const openStarted = new Promise<void>((resolve) => { opened = resolve; });
    const writes: TokenSet[] = [];
    const pending = login({ clientId: "client", clientSecret: secretCanary, redirectUri: `http://127.0.0.1:${port}/callback` }, dependencies({
      openBrowser: () => opened?.(),
      protocol: protocol(),
      tokenSink: { write: async (value) => { writes.push(value); } }
    }));
    await openStarted;
    await sendCallback(port, `/callback?code=one-time-code&state=${state}`);
    await expect(pending).resolves.toEqual({
      ok: true,
      value: { state: "authenticated", expiresAt: new Date(now + 60_000).toISOString(), grantedScopes: null }
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.grantedScopes).toBeNull();
    await expectPortAvailable(port);
  });

  it("does not exchange a rejected callback and accepts a valid denial only after state validation", async () => {
    const port = await unusedPort();
    let exchanges = 0;
    let opened: (() => void) | undefined;
    const openStarted = new Promise<void>((resolve) => { opened = resolve; });
    const resultPromise = login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${port}/callback` }, dependencies({
      openBrowser: () => opened?.(),
      protocol: protocol({ exchangeCode: async () => { exchanges++; return token(); } })
    }));
    await openStarted;
    await sendCallback(port, "/callback?code=bad&state=not-the-state");
    await sendCallback(port, `/callback?error=access_denied&state=${state}`);
    await expect(resultPromise).resolves.toEqual({ ok: false, error: { code: "ACCESS_DENIED", retryable: false } });
    expect(exchanges).toBe(0);
    await expectPortAvailable(port);
  });

  it("returns static exact errors and always releases callback resources", async () => {
    const invalidConfig = await login({ clientId: "client", clientSecret: "secret", redirectUri: "https://example.test/callback" }, dependencies());
    expect(invalidConfig).toEqual({ ok: false, error: { code: "CONFIG_INVALID", retryable: false } });

    const occupiedPort = await unusedPort();
    const occupied = createServer();
    await new Promise<void>((resolve) => occupied.listen({ host: "127.0.0.1", port: occupiedPort }, resolve));
    try {
      await expect(login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${occupiedPort}/callback` }, dependencies())).resolves.toEqual({ ok: false, error: { code: "CALLBACK_BIND_FAILED", retryable: false } });
    } finally {
      await new Promise<void>((resolve, reject) => occupied.close((error) => error ? reject(error) : resolve()));
    }

    const timeoutPort = await unusedPort();
    await expect(login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${timeoutPort}/callback` }, dependencies({ callbackTimeoutMs: 10, protocol: protocol() }))).resolves.toEqual({ ok: false, error: { code: "CALLBACK_TIMEOUT", retryable: true } });
    const rebound = createServer();
    await new Promise<void>((resolve) => rebound.listen({ host: "127.0.0.1", port: timeoutPort }, resolve));
    await new Promise<void>((resolve, reject) => rebound.close((error) => error ? reject(error) : resolve()));

    const cancelPort = await unusedPort();
    const controller = new AbortController();
    let opened: (() => void) | undefined;
    const openStarted = new Promise<void>((resolve) => { opened = resolve; });
    const cancelled = login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${cancelPort}/callback` }, dependencies({ openBrowser: () => opened?.(), signal: controller.signal, protocol: protocol() }));
    await openStarted;
    controller.abort();
    await expect(cancelled).resolves.toEqual({ ok: false, error: { code: "CANCELLED", retryable: true } });
    await expectPortAvailable(cancelPort);
  });

  it("fails closed for exchange, token-validation, and sink errors without leaking provider text", async () => {
    const cases: Array<{ name: string; protocol: OAuthProtocol; error: string }> = [
      { name: "exchange", protocol: protocol({ exchangeCode: async () => { throw new Error(secretCanary); } }), error: "TOKEN_EXCHANGE_FAILED" },
      { name: "missing refresh", protocol: protocol({ exchangeCode: async () => ({ accessToken: "access", refreshToken: undefined, expiresAt: now + 60_000 }) }), error: "INVALID_TOKEN_RESPONSE" },
      { name: "expired", protocol: protocol({ exchangeCode: async () => token(now) }), error: "INVALID_TOKEN_RESPONSE" },
      { name: "out of range expiry", protocol: protocol({ exchangeCode: async () => token(Number.MAX_VALUE) }), error: "INVALID_TOKEN_RESPONSE" }
    ];
    for (const item of cases) {
      const port = await unusedPort();
      let opened: (() => void) | undefined;
      const openStarted = new Promise<void>((resolve) => { opened = resolve; });
      const pending = login({ clientId: "client", clientSecret: secretCanary, redirectUri: `http://127.0.0.1:${port}/callback` }, dependencies({ openBrowser: () => opened?.(), protocol: item.protocol }));
      await openStarted;
      await sendCallback(port, `/callback?code=code&state=${state}`);
      const result = await pending;
      expect(result).toEqual({ ok: false, error: { code: item.error, retryable: item.error === "TOKEN_EXCHANGE_FAILED" } });
      expect(JSON.stringify(result)).not.toContain(secretCanary);
      await expectPortAvailable(port);
    }

    const malformedPort = await unusedPort();
    let malformedOpened: (() => void) | undefined;
    const malformedOpenStarted = new Promise<void>((resolve) => { malformedOpened = resolve; });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const malformed = login({ clientId: "client", clientSecret: secretCanary, redirectUri: `http://127.0.0.1:${malformedPort}/callback` }, dependencies({
        openBrowser: () => malformedOpened?.(),
        tokenFetch: async () => new Response(JSON.stringify({ access_token: "access", error_description: secretCanary }), {
          headers: { "content-type": "application/json" }
        })
      }));
      await malformedOpenStarted;
      await sendCallback(malformedPort, `/callback?code=code&state=${state}`);
      await expect(malformed).resolves.toEqual({ ok: false, error: { code: "INVALID_TOKEN_RESPONSE", retryable: false } });
      expect(warning).not.toHaveBeenCalled();
      await expectPortAvailable(malformedPort);
    } finally {
      warning.mockRestore();
    }

    const providerErrorPort = await unusedPort();
    let providerOpened: (() => void) | undefined;
    const providerOpenStarted = new Promise<void>((resolve) => { providerOpened = resolve; });
    const providerError = login({ clientId: "client", clientSecret: secretCanary, redirectUri: `http://127.0.0.1:${providerErrorPort}/callback` }, dependencies({
      openBrowser: () => providerOpened?.(),
      tokenFetch: async () => new Response(JSON.stringify({ error: "invalid_grant", error_description: secretCanary }), {
        status: 400,
        headers: { "content-type": "application/json" }
      })
    }));
    await providerOpenStarted;
    await sendCallback(providerErrorPort, `/callback?code=code&state=${state}`);
    const providerErrorResult = await providerError;
    expect(providerErrorResult).toEqual({ ok: false, error: { code: "TOKEN_EXCHANGE_FAILED", retryable: true } });
    expect(JSON.stringify(providerErrorResult)).not.toContain(secretCanary);
    await expectPortAvailable(providerErrorPort);

    const sinkPort = await unusedPort();
    let opened: (() => void) | undefined;
    const openStarted = new Promise<void>((resolve) => { opened = resolve; });
    const sinkFailure = login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${sinkPort}/callback` }, dependencies({
      openBrowser: () => opened?.(),
      protocol: protocol(),
      tokenSink: { write: async () => { throw new Error(secretCanary); } }
    }));
    await openStarted;
    await sendCallback(sinkPort, `/callback?code=code&state=${state}`);
    await expect(sinkFailure).resolves.toEqual({ ok: false, error: { code: "CREDENTIAL_STORE_UNAVAILABLE", retryable: false } });
    await expectPortAvailable(sinkPort);
  });

  it("bounds and cancels post-callback work before token persistence", async () => {
    const cancelPort = await unusedPort();
    const controller = new AbortController();
    let opened: (() => void) | undefined;
    let exchangeStarted: (() => void) | undefined;
    const openStarted = new Promise<void>((resolve) => { opened = resolve; });
    const started = new Promise<void>((resolve) => { exchangeStarted = resolve; });
    const writes: TokenSet[] = [];
    const cancelled = login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${cancelPort}/callback` }, dependencies({
      openBrowser: () => opened?.(),
      signal: controller.signal,
      protocol: protocol({ exchangeCode: async ({ signal }) => {
        exchangeStarted?.();
        return new Promise<OAuthToken>((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      } }),
      tokenSink: { write: async (value) => { writes.push(value); } }
    }));
    await openStarted;
    await sendCallback(cancelPort, `/callback?code=code&state=${state}`);
    await started;
    controller.abort();
    await expect(cancelled).resolves.toEqual({ ok: false, error: { code: "CANCELLED", retryable: true } });
    expect(writes).toEqual([]);
    await expectPortAvailable(cancelPort);

    const timeoutPort = await unusedPort();
    let timeoutOpened: (() => void) | undefined;
    const timeoutOpenStarted = new Promise<void>((resolve) => { timeoutOpened = resolve; });
    const timedOut = login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${timeoutPort}/callback` }, dependencies({
      openBrowser: () => timeoutOpened?.(),
      postCallbackTimeoutMs: 10,
      protocol: protocol({ exchangeCode: async () => new Promise<OAuthToken>(() => undefined) })
    }));
    await timeoutOpenStarted;
    await sendCallback(timeoutPort, `/callback?code=code&state=${state}`);
    await expect(timedOut).resolves.toEqual({ ok: false, error: { code: "TOKEN_EXCHANGE_FAILED", retryable: true } });
    await expectPortAvailable(timeoutPort);

    const transportPort = await unusedPort();
    const transportController = new AbortController();
    let transportOpened: (() => void) | undefined;
    let fetchStarted: (() => void) | undefined;
    const transportOpenStarted = new Promise<void>((resolve) => { transportOpened = resolve; });
    const transportFetchStarted = new Promise<void>((resolve) => { fetchStarted = resolve; });
    let tokenRequestSignal: AbortSignal | null | undefined;
    const transportCancelled = login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${transportPort}/callback` }, dependencies({
      openBrowser: () => transportOpened?.(),
      signal: transportController.signal,
      tokenFetch: async (_input, init) => {
        tokenRequestSignal = init?.signal;
        fetchStarted?.();
        return new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
      }
    }));
    await transportOpenStarted;
    await sendCallback(transportPort, `/callback?code=code&state=${state}`);
    await transportFetchStarted;
    transportController.abort();
    await expect(transportCancelled).resolves.toEqual({ ok: false, error: { code: "CANCELLED", retryable: true } });
    expect(tokenRequestSignal?.aborted).toBe(true);
    await expectPortAvailable(transportPort);

    const sinkPort = await unusedPort();
    let sinkOpened: (() => void) | undefined;
    const sinkOpenStarted = new Promise<void>((resolve) => { sinkOpened = resolve; });
    let delayedWrites = 0;
    const stalledSink = login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${sinkPort}/callback` }, dependencies({
      openBrowser: () => sinkOpened?.(),
      postCallbackTimeoutMs: 10,
      protocol: protocol(),
      tokenSink: { write: async (_tokenSet, signal) => new Promise<void>((resolve, reject) => {
        const commit = setTimeout(() => {
          delayedWrites++;
          resolve();
        }, 30);
        signal.addEventListener("abort", () => {
          clearTimeout(commit);
          reject(new Error("aborted"));
        }, { once: true });
      }) }
    }));
    await sinkOpenStarted;
    await sendCallback(sinkPort, `/callback?code=code&state=${state}`);
    await expect(stalledSink).resolves.toEqual({ ok: false, error: { code: "CREDENTIAL_STORE_UNAVAILABLE", retryable: false } });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(delayedWrites).toBe(0);
    await expectPortAvailable(sinkPort);

    const cancelledSinkPort = await unusedPort();
    const sinkController = new AbortController();
    let cancelledSinkOpened: (() => void) | undefined;
    let sinkWriteStarted: (() => void) | undefined;
    const cancelledSinkOpenStarted = new Promise<void>((resolve) => { cancelledSinkOpened = resolve; });
    const writeStarted = new Promise<void>((resolve) => { sinkWriteStarted = resolve; });
    let writesAfterCancellation = 0;
    const cancelledSink = login({ clientId: "client", clientSecret: "secret", redirectUri: `http://127.0.0.1:${cancelledSinkPort}/callback` }, dependencies({
      openBrowser: () => cancelledSinkOpened?.(),
      signal: sinkController.signal,
      protocol: protocol(),
      tokenSink: { write: async (_tokenSet, signal) => new Promise<void>((resolve, reject) => {
        sinkWriteStarted?.();
        const commit = setTimeout(() => {
          writesAfterCancellation++;
          resolve();
        }, 30);
        signal.addEventListener("abort", () => {
          clearTimeout(commit);
          reject(new Error("aborted"));
        }, { once: true });
      }) }
    }));
    await cancelledSinkOpenStarted;
    await sendCallback(cancelledSinkPort, `/callback?code=code&state=${state}`);
    await writeStarted;
    sinkController.abort();
    await expect(cancelledSink).resolves.toEqual({ ok: false, error: { code: "CANCELLED", retryable: true } });
    await new Promise<void>((resolve) => setTimeout(resolve, 40));
    expect(writesAfterCancellation).toBe(0);
    await expectPortAvailable(cancelledSinkPort);
  });

  it("rejects unsafe redirects and exposes only the specified static error messages", () => {
    for (const redirectUri of [
      "http://localhost/callback",
      "http://localhost:0/callback",
      "http://localhost:8788/",
      "http://localhost:8788/callback?state=x",
      "http://user@localhost:8788/callback",
      "http://[::1]:8788/callback",
      "http://example.test:8788/callback"
    ]) {
      expect(validateOuraAuthConfig({ clientId: "client", clientSecret: "secret", redirectUri })).toBeNull();
    }
    expect(publicAuth).not.toHaveProperty("startCallbackListener");
    const messages = ["CONFIG_INVALID", "CALLBACK_BIND_FAILED", "CALLBACK_TIMEOUT", "ACCESS_DENIED", "TOKEN_EXCHANGE_FAILED", "INVALID_TOKEN_RESPONSE", "CREDENTIAL_STORE_UNAVAILABLE", "CANCELLED"] as const;
    for (const code of messages) {
      expect(authErrorMessage(code)).toMatch(/\.$/);
      expect(authErrorMessage(code)).not.toContain(secretCanary);
    }
  });
});
