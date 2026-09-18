# G1 — Live Oura REST Use Approval

Date: 2026-09-18

Status: APPROVED

## Scope

This approval covers:

- live Oura OAuth acceptance
- local Oura REST use
- OAuth scopes `daily` and `workout`
- Slice 5 live authentication acceptance
- later Slice 7 local REST inspection within the same approved boundaries

It does not approve Oura REST data for external AI or LLM processing.

## Reviewed

The project owner confirmed:

- the registered Oura application purpose matches the current project
- the registered callback URI matches the production OAuth implementation
- only `daily` and `workout` scopes are enabled and requested
- the current implementation has no Oura REST-to-agent or REST-to-OpenAI path
- the published privacy policy reflects the current implementation
- local logout and provider-side revocation semantics are documented
- current consent, local processing, retention, and deletion behavior were
  reviewed

## Registered OAuth callbacks

The registered Oura application callbacks reviewed for G1 are:

- `http://localhost:3000/oauth/callback`
- `http://localhost:8788/callback`

The live acceptance run may use either registered callback, provided the
runtime `OURA_REDIRECT_URI` exactly matches one of these values.


## Oura agreement

The Oura API and MCP Agreement was rechecked on 2026-09-18.

The effective version remains June 8, 2026, matching the version used during
the project's architecture review.

The project continues to enforce the architectural restriction that Oura user
data obtained through the REST API must not be provided to an external LLM or
AI platform.

Live Oura AI integration remains separately gated by G2/G3 and is not approved
by this record.

## Data recorded

This approval record contains no:

- Oura user data
- OAuth authorization codes
- access tokens
- refresh tokens
- client secrets
- personal health information

## Slice 5 live-auth acceptance history

### Initial run — 2026-09-18 (before Keychain adapter fix)

- Baseline commit: `703ab813f4ce55c25a204b76b2fbdaa371858f0b`
- Adapter/library versions: `@napi-rs/keyring` 2.1.0;
  `@badgateway/oauth2-client` 3.3.1
- Login: PASS
- Status: PASS
- Granted scopes: unknown
- Refresh: PENDING (token was outside the production refresh window)
- Logout: PASS
- Fresh-process final status: FAIL (`REAUTH_REQUIRED`)

### Rerun — 2026-09-18 (uncommitted Keychain adapter fix)

- Baseline commit: `703ab813f4ce55c25a204b76b2fbdaa371858f0b`
- Adapter/library versions: `@napi-rs/keyring` 2.1.0;
  `@badgateway/oauth2-client` 3.3.1
- Runtime callback registration check: PASS
- Requested scopes: `daily`, `workout`
- Login: PASS
- Status: PASS
- Granted scopes: unknown
- Refresh: PENDING (token was outside the production refresh window)
- Logout: PASS
- Fresh-process final status: PASS (`unauthenticated`)
- Post-logout native Keychain absence result: `null`

The login result was already `unknown` before a subsequent Keychain read, and
the same state was subsequently read from the store. No requested-scope
fallback was applied. This is inconsistent with the current Oura documentation,
which states that a successful authorization-code redirect includes `scope`.
No Oura health-data endpoint was called during either run.
