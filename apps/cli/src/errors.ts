export const AUTH_ERROR_TEXT: Record<string, string> = {
  CONFIG_INVALID: "Oura configuration is invalid.",
  CREDENTIAL_STORE_UNAVAILABLE: "Credential storage is unavailable.",
  AUTH_BUSY: "Another authentication operation is in progress. If it ended unexpectedly, confirm no authentication process is running, then manually remove the stale local auth lock before retrying.",
  UNAUTHENTICATED: "No local Oura session is available. Run health auth login.",
  REAUTH_REQUIRED: "Local Oura credentials need a fresh login. Run health auth login.",
  CANCELLED: "Authentication was cancelled.",
  CALLBACK_BIND_FAILED: "The OAuth callback listener could not start.",
  CALLBACK_TIMEOUT: "The OAuth callback timed out.",
  ACCESS_DENIED: "OAuth access was denied.",
  TOKEN_EXCHANGE_FAILED: "The OAuth token exchange failed.",
  INVALID_TOKEN_RESPONSE: "The OAuth token response was invalid."
};

export function authErrorText(code: string): string { return AUTH_ERROR_TEXT[code] ?? "Authentication failed."; }
