import { spawn } from "node:child_process";
import { parseArgs } from "node:util";
import {
  createMacOSKeychainTokenStore,
  FileAuthLock,
  login,
  OuraSession,
  systemAuthDependencies,
  type AuthStatus,
  type OuraAuthConfig,
  type TokenStore
} from "@ahp/oura-client/auth";

import { authErrorText } from "./errors.js";

type Output = (line: string) => void;
type AuthCommandDependencies = {
  environment?: NodeJS.ProcessEnv;
  store?: TokenStore;
  openBrowser?: (url: string) => Promise<void>;
  signal?: AbortSignal;
  lock?: { acquire(): Promise<{ release(): Promise<void> } | null> };
};

function exitCodeForAuthError(code: string): number {
  if (code === "CONFIG_INVALID") return 2;
  if (code === "CANCELLED") return 130;
  return 3;
}

function configuration(environment: NodeJS.ProcessEnv): OuraAuthConfig | null {
  const clientId = environment.OURA_CLIENT_ID;
  const clientSecret = environment.OURA_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret, ...(environment.OURA_REDIRECT_URI ? { redirectUri: environment.OURA_REDIRECT_URI } : {}) };
}

function formatStatus(status: AuthStatus): string {
  if (status.state !== "authenticated") return `Oura authentication: ${status.state}.`;
  return `Oura authentication: authenticated (expires ${status.expiresAt}; scopes ${status.grantedScopes?.join(", ") ?? "unknown"}).`;
}

function systemBrowser(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // Direct spawn avoids shell interpolation; the URL contains no credentials.
    const child = spawn("/usr/bin/open", [url], { stdio: "ignore" });
    child.once("error", reject);
    child.once("spawn", resolve);
  });
}

export async function runAuthCommand(argv: readonly string[], output: Output, dependencies: AuthCommandDependencies = {}): Promise<number> {
  let positionals: string[];
  try { positionals = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: {} }).positionals; }
  catch { output("Usage: health auth <login|status|logout>"); return 2; }
  if (positionals.length !== 1 || !["login", "status", "logout"].includes(positionals[0] ?? "")) {
    output("Usage: health auth <login|status|logout>"); return 2;
  }
  const config = configuration(dependencies.environment ?? process.env);
  if (config === null) { output(authErrorText("CONFIG_INVALID")); return exitCodeForAuthError("CONFIG_INVALID"); }
  let store: TokenStore;
  try { store = dependencies.store ?? await createMacOSKeychainTokenStore(config.clientId); }
  catch { output(authErrorText("CREDENTIAL_STORE_UNAVAILABLE")); return exitCodeForAuthError("CREDENTIAL_STORE_UNAVAILABLE"); }
  const lock = dependencies.lock ?? new FileAuthLock(config.clientId);
  const session = new OuraSession(config, { store, lock, ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }) });
  const command = positionals[0];
  if (command === "status") {
    const result = await session.getStatus();
    if (!result.ok) { output(authErrorText(result.error.code)); return exitCodeForAuthError(result.error.code); }
    output(formatStatus(result.value)); return 0;
  }
  if (command === "logout") {
    const result = await session.logout();
    if (!result.ok) { output(authErrorText(result.error.code)); return exitCodeForAuthError(result.error.code); }
    output(`${formatStatus(result.value)} Remove authorization in Oura separately if desired.`); return 0;
  }
  const held = await lock.acquire().catch(() => null);
  if (held === null) { output(authErrorText("AUTH_BUSY")); return exitCodeForAuthError("AUTH_BUSY"); }
  try {
    const result = await login(config, {
      ...systemAuthDependencies,
      openBrowser: dependencies.openBrowser ?? systemBrowser,
      ...(dependencies.signal === undefined ? {} : { signal: dependencies.signal }),
      tokenSink: { write: (tokens, signal) => store.write(tokens, signal) }
    });
    if (!result.ok) { output(authErrorText(result.error.code)); return exitCodeForAuthError(result.error.code); }
    output(formatStatus(result.value)); return 0;
  } finally { await held.release().catch(() => undefined); }
}
