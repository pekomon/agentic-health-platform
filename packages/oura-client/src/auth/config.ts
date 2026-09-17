import type { OuraAuthConfig } from "./types.js";

export const OURA_AUTHORIZATION_ENDPOINT =
  "https://cloud.ouraring.com/oauth/authorize";
export const OURA_TOKEN_ENDPOINT = "https://api.ouraring.com/oauth/token";
export const DEFAULT_REDIRECT_URI = "http://localhost:8788/callback";
export const OURA_SCOPES = ["daily", "workout"] as const;
export const CALLBACK_TIMEOUT_MS = 180_000;
export const STATE_BYTES = 32;

export type ValidatedOuraAuthConfig = {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
};

export function validateLoopbackRedirectUri(redirectUri: string): string | null {
  let url: URL;
  try {
    url = new URL(redirectUri);
  } catch {
    return null;
  }

  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535 ||
    url.pathname === "/" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    url.href !== redirectUri
  ) {
    return null;
  }

  return redirectUri;
}

export function validateOuraAuthConfig(
  config: OuraAuthConfig
): ValidatedOuraAuthConfig | null {
  if (
    typeof config?.clientId !== "string" ||
    config.clientId.length === 0 ||
    typeof config.clientSecret !== "string" ||
    config.clientSecret.length === 0
  ) {
    return null;
  }

  const redirectUri = validateLoopbackRedirectUri(config.redirectUri ?? DEFAULT_REDIRECT_URI);
  if (redirectUri === null) return null;

  return { clientId: config.clientId, clientSecret: config.clientSecret, redirectUri };
}
