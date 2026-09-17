import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { Socket } from "node:net";
import { validateLoopbackRedirectUri } from "./config.js";

export type CallbackResult =
  | { kind: "code"; code: string; grantedScopes: string[] | null }
  | { kind: "denied" };

export type CallbackAttempt = {
  wait(): Promise<CallbackResult>;
  close(): Promise<void>;
};

function isLoopbackAddress(address: string | undefined): boolean {
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1"
  );
}

function statesMatch(expected: string, received: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const receivedBytes = Buffer.from(received, "utf8");
  return (
    expectedBytes.length === receivedBytes.length &&
    timingSafeEqual(expectedBytes, receivedBytes)
  );
}

function genericResponse(response: ServerResponse): void {
  response.writeHead(200, {
    "cache-control": "no-store",
    "content-type": "text/plain; charset=utf-8",
    connection: "close"
  });
  response.end("Authentication response received. You may close this window.");
}

function hasDuplicateParameters(url: URL): boolean {
  const names = new Set<string>();
  for (const [name] of url.searchParams) {
    if (names.has(name)) return true;
    names.add(name);
  }
  return false;
}

function scopesFromCallback(scope: string | null): string[] | null {
  if (scope === null) return null;
  const scopes = scope.split(" ").filter((item) => item.length > 0);
  return scopes.length > 0 ? scopes : null;
}

function matchesHost(request: IncomingMessage, redirect: URL): boolean {
  const host = request.headers.host;
  return host !== undefined && host.toLowerCase() === redirect.host.toLowerCase();
}

export async function startCallbackListener(
  redirectUri: string,
  expectedState: string
): Promise<CallbackAttempt> {
  const validatedRedirectUri = validateLoopbackRedirectUri(redirectUri);
  if (validatedRedirectUri === null) {
    throw new Error("Invalid loopback callback configuration.");
  }
  const redirect = new URL(validatedRedirectUri);
  const sockets = new Set<Socket>();
  let server: Server | undefined;
  let consumed = false;
  let resolveCallback: ((result: CallbackResult) => void) | undefined;
  const callback = new Promise<CallbackResult>((resolve) => {
    resolveCallback = resolve;
  });

  const onRequest = (request: IncomingMessage, response: ServerResponse): void => {
    genericResponse(response);
    if (
      consumed ||
      request.method !== "GET" ||
      !isLoopbackAddress(request.socket.remoteAddress) ||
      !matchesHost(request, redirect) ||
      request.url === undefined
    ) {
      return;
    }

    let callbackUrl: URL;
    try {
      callbackUrl = new URL(request.url, validatedRedirectUri);
    } catch {
      return;
    }
    if (
      callbackUrl.origin !== redirect.origin ||
      callbackUrl.pathname !== redirect.pathname ||
      hasDuplicateParameters(callbackUrl)
    ) {
      return;
    }

    const state = callbackUrl.searchParams.get("state");
    const code = callbackUrl.searchParams.get("code");
    const error = callbackUrl.searchParams.get("error");
    if (
      state === null ||
      state.length === 0 ||
      !statesMatch(expectedState, state) ||
      ((code === null && error === null) || (code !== null && error !== null)) ||
      (code !== null && code.length === 0) ||
      (error !== null && error.length === 0)
    ) {
      return;
    }

    consumed = true;
    if (code !== null) {
      resolveCallback?.({
        kind: "code",
        code,
        grantedScopes: scopesFromCallback(callbackUrl.searchParams.get("scope"))
      });
      return;
    }
    resolveCallback?.({ kind: "denied" });
  };

  try {
    const callbackServer = createServer(onRequest);
    server = callbackServer;
    callbackServer.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        callbackServer.off("listening", onListening);
        reject(error);
      };
      const onListening = (): void => {
        callbackServer.off("error", onError);
        resolve();
      };
      callbackServer.once("error", onError);
      callbackServer.once("listening", onListening);
      callbackServer.listen({ host: redirect.hostname, port: Number(redirect.port) });
    });
  } catch (error) {
    await closeServer(server, sockets);
    throw error;
  }

  return {
    wait: () => callback,
    close: () => closeServer(server, sockets)
  };
}

async function closeServer(
  server: Server | undefined,
  sockets: ReadonlySet<Socket>
): Promise<void> {
  for (const socket of sockets) socket.destroy();
  if (server === undefined || !server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}
