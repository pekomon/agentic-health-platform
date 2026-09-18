import { createHash } from "node:crypto";

import { MalformedTokenSetError, parseTokenSet, type TokenStore } from "./store.js";
import type { TokenSet } from "./types.js";

const SERVICE = "agentic-health-platform.oura";

export type KeychainEntry = {
  /**
   * The pinned native adapter declares `undefined` for an absent credential,
   * but its macOS boundary may return `null`. Both mean no credential exists.
   */
  getPassword(signal?: AbortSignal): Promise<string | null | undefined>;
  setPassword(value: string, signal?: AbortSignal): Promise<void>;
  deleteCredential(signal?: AbortSignal): Promise<boolean>;
};

export class CredentialStoreUnavailableError extends Error {
  constructor() { super("Credential storage is unavailable."); }
}

export class MacOSKeychainTokenStore implements TokenStore {
  constructor(private readonly entry: KeychainEntry) {}

  async read(): Promise<TokenSet | null> {
    try {
      const value = await this.entry.getPassword();
      return value == null ? null : parseTokenSet(JSON.parse(value) as unknown);
    } catch (error) {
      if (error instanceof MalformedTokenSetError || (error instanceof Error && error.name === "SyntaxError")) {
        throw new MalformedTokenSetError();
      }
      throw new CredentialStoreUnavailableError();
    }
  }

  async write(tokens: TokenSet, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new CredentialStoreUnavailableError();
    try { await this.entry.setPassword(JSON.stringify(tokens), signal); }
    catch { throw new CredentialStoreUnavailableError(); }
  }

  async clear(): Promise<void> {
    try {
      await this.entry.deleteCredential();
      // A reported deletion is not enough: a fresh read must observe absence
      // before session logout can claim success.
      if ((await this.entry.getPassword()) != null) throw new CredentialStoreUnavailableError();
    } catch { throw new CredentialStoreUnavailableError(); }
  }
}

type KeychainStoreDependencies = {
  platform?: NodeJS.Platform;
  createEntry?: (service: string, account: string) => KeychainEntry;
};

export async function createMacOSKeychainTokenStore(
  clientId: string,
  dependencies: KeychainStoreDependencies = {}
): Promise<TokenStore> {
  if ((dependencies.platform ?? process.platform) !== "darwin" || typeof clientId !== "string" || clientId.length === 0) {
    throw new CredentialStoreUnavailableError();
  }
  try {
    const account = createHash("sha256").update(clientId).digest("hex");
    if (dependencies.createEntry !== undefined) return new MacOSKeychainTokenStore(dependencies.createEntry(SERVICE, account));
    const { AsyncEntry } = await import("@napi-rs/keyring");
    return new MacOSKeychainTokenStore(new AsyncEntry(SERVICE, account));
  } catch {
    throw new CredentialStoreUnavailableError();
  }
}
