import { InstantSchema } from "@ahp/health-domain";

import type { TokenSet } from "./types.js";

export interface TokenStore {
  read(): Promise<TokenSet | null>;
  /** Aborting before the durable Keychain commit must not leave a new token set. */
  write(tokens: TokenSet, signal?: AbortSignal): Promise<void>;
  clear(): Promise<void>;
}

export class MalformedTokenSetError extends Error {
  constructor() {
    super("Stored credentials are malformed.");
  }
}

export function parseTokenSet(value: unknown): TokenSet {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new MalformedTokenSetError();
  const token = value as Record<string, unknown>;
  if (
    token.version !== 1 ||
    typeof token.accessToken !== "string" || token.accessToken.length === 0 ||
    typeof token.refreshToken !== "string" || token.refreshToken.length === 0 ||
    typeof token.expiresAt !== "string" ||
    !InstantSchema.safeParse(token.expiresAt).success ||
    !Number.isFinite(new Date(token.expiresAt).getTime()) ||
    (token.grantedScopes !== null && (!Array.isArray(token.grantedScopes) || token.grantedScopes.some((scope) => typeof scope !== "string")))
  ) throw new MalformedTokenSetError();
  return {
    accessToken: token.accessToken,
    refreshToken: token.refreshToken,
    expiresAt: token.expiresAt,
    grantedScopes: token.grantedScopes === null ? null : [...token.grantedScopes] as string[],
    version: 1
  };
}
