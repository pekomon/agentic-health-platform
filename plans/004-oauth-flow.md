# Slice 4 — Isolated Authorization-Code Flow

Status: PLANNED — dependency-ready candidate; explicit implementation approval required  
Planning baseline: `8d4efab4fd3b403891e01c115e9e71cad8031dd9`

## Required reading

- `specs/architecture.md`: Oura provider, Authentication, Security and privacy.
- `specs/v0.1.md`: Authentication, Persistence, Security and privacy.
- `plan.md`.
- This file.
- `packages/health-domain/src/index.ts` for the existing public domain surface, and `packages/health-domain/src/observation.ts` only if importing its instant validation.
- Root `package.json`, `tsconfig.base.json`, and `vitest.config.ts` for the existing workspace/toolchain conventions.

Do not read other slice plans or the archived monolithic plan unless this handoff explicitly references them.

## Existing code dependencies

`@ahp/health-domain` exists and exports canonical `InstantSchema` and other public package boundaries from `packages/health-domain/src/index.ts`. Its synchronous `ValidationResult` is not the auth result contract. There is no `packages/oura-client` or `apps/cli` at the baseline. This slice creates only the provider package and OAuth flow; it does not depend on MCP or agent work.

## Goal

Implement a secure deterministic Oura authorization-code login state machine with fake HTTP and token persistence dependencies, without touching real credentials.

## Scope

- OAuth configuration and validation.
- Authorization request construction.
- Narrow localhost callback listener and CSRF-state validation.
- One authorization-code exchange and strict token-response validation.
- Finite cancellation/timeouts and static sanitized errors.
- Inject browser opener, HTTP/token operations supported by the maintained OAuth library, random bytes, clock, and token sink for deterministic tests.

Use a maintained OAuth library for authorization-request encoding and authorization-code token-request plumbing. `oauth4webapi` was reviewed and rejected because it requires authorization-server issuer metadata that Oura does not document; do not invent an issuer. `@badgateway/oauth2-client@3.3.1` is the approved candidate, subject to exact pinned-source verification before implementation. Configure Oura's documented authorization and token endpoints explicitly and do not use discovery. The library must not own loopback listener behavior, callback validation, state handling, replay/attempt semantics, timeout/cancellation, redaction, or fail-closed behavior; application code owns those responsibilities. Do not add PKCE without documented Oura support. Use `client_secret_post` only if the exact pinned library source confirms that it produces Oura's documented form-body flow. Node HTTP owns only the narrow loopback callback.

## Non-goals

No Keychain adapter, persisted session, refresh lifecycle, real login acceptance, health endpoint, CLI, MCP, agent, broad scope set, PKCE invented without provider support, diagnostic-probe import, pasted URL, or raw-code shortcut.

## Files and ownership

Create `packages/oura-client` only when this slice begins, including its package manifest, TypeScript configuration, package entry, and focused tests. OAuth implementation ownership is:

- `src/auth/config.ts`
- `src/auth/flow.ts`
- `src/auth/callback.ts`
- `src/auth/types.ts`
- `test/auth-flow.test.ts`
- `test/callback.test.ts`

Root workspace/lock/compiler/test configuration may change only as needed to add this package and the reviewed OAuth dependency. These names constrain ownership; internal factoring may change if no public contract or slice boundary changes. Do not modify health-tools or health-agent.

## Public contracts

Expose auth types through an `@ahp/oura-client/auth` subpath, not through health-domain or health-tools.

Do not reuse the domain package's synchronous `ValidationResult`; it is not the public async error contract. Export this exact provider-boundary result shape from the auth subpath:

```ts
type Result<T, E extends { code: string; retryable: boolean }> =
  | { ok: true; value: T }
  | { ok: false; error: E };

type AuthError =
  | { code: "CONFIG_INVALID"; retryable: false }
  | { code: "CALLBACK_BIND_FAILED"; retryable: false }
  | { code: "CALLBACK_TIMEOUT"; retryable: true }
  | { code: "ACCESS_DENIED"; retryable: false }
  | { code: "TOKEN_EXCHANGE_FAILED"; retryable: true }
  | { code: "INVALID_TOKEN_RESPONSE"; retryable: false }
  | { code: "CREDENTIAL_STORE_UNAVAILABLE"; retryable: false }
  | { code: "CANCELLED"; retryable: true };
```

`retryable: true` means the caller may initiate a completely fresh `login` operation. It never permits retrying an authorization-code exchange, reusing a state/code, or adding an automatic retry loop. A changed configuration or resolved external precondition may make a `retryable: false` error actionable, but the same failed operation must not be retried blindly.

`login(config, dependencies): Promise<Result<AuthStatus, AuthError>>`

`AuthStatus` is exactly the non-secret public state:

```ts
type AuthStatus = {
  state: "authenticated" | "unauthenticated" | "reauth_required";
  expiresAt: Instant | null;
  grantedScopes: string[] | null;
};
```

The private persistence payload is:

```ts
type TokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresAt: Instant;
  grantedScopes: string[] | null;
  version: 1;
};
```

The injected sink exposes only `write(TokenSet, AbortSignal): Promise<void>` and is never a tool. Its implementation must be cancellation-aware and atomic: if its signal aborts before durable commit, it must reject without a durable write; if it resolves, the write is committed. The flow supplies a bounded per-operation signal and must not return a terminal error while a later sink completion could persist credentials.

Initial provider values, subject to current official verification before coding:

- authorize URL: `https://cloud.ouraring.com/oauth/authorize`
- token URL: `https://api.ouraring.com/oauth/token`
- registered redirect default: `http://localhost:8788/callback`
- expected least-privilege scopes: `daily workout`

Do not copy the diagnostic probe's broader scopes. Omit personal, email, heartrate, tag, session, and spo2 unless current official endpoint evidence establishes a v0.1 need and the handoff is reviewed.

Accept configured redirects only when they are HTTP, exactly `localhost` or `127.0.0.1`, include an explicit fixed port/path, and contain no username, password, query, or fragment. Bind only loopback. A busy registered port is an error; never choose a different redirect silently.

State machine:

1. Bind listener successfully.
2. Generate at least 32 CSPRNG bytes and encode base64url.
3. Construct the authorization URL.
4. Pass it as an argument to the injected browser opener.
5. Await a matching callback within the finite initial 180-second timeout.
6. Exchange one accepted code once.
7. Strictly validate the token response.
8. Await sink persistence.
9. Return non-secret authenticated status.

The callback accepts only GET at the exact path/host from a loopback remote address, exactly one nonempty matching state, and exactly one code or error. Validate state even on denial. Wrong path/state does not consume the legitimate pending attempt; timeout still bounds it. A valid denial consumes the attempt. Compare equal-length state bytes in constant time. Close the listener in `finally`. The browser response is generic, reflects no parameters, and uses no-store headers.

Use form-body client authentication and the exact redirect during exchange. Authorization codes are single-use and never automatically retried. Redirects from the token endpoint are refused.

## Invariants

- Follow all global security/privacy invariants in `plan.md`.
- Listener binding precedes browser opening.
- Secrets, code, state, authorization URL, provider body/description, and callback query never appear in logs, exceptions, status, or CLI-shaped values.
- Missing configuration fails before listener/network work.
- No shell interpolation opens the browser.
- State validation, finite deadlines, single-use code handling, and least privilege cannot be weakened for convenience.

## External/provider checks before coding

- Verify current Oura authorize/token endpoints, client-auth method, redirect-matching requirements, token response, refresh-token presence, and rotating-token semantics from official sources.
- Verify exact scopes required by the three planned v0.1 REST collections. Record evidence before changing the expected scope set.
- Verify whether Oura currently documents/supports PKCE for this confidential localhost flow. Absence of proof means do not add it; contradictory requirements stop the slice.
- Verify the exact pinned `@badgateway/oauth2-client@3.3.1` source/API: explicit absolute authorization and token endpoints must work without discovery or undocumented issuer metadata; `client_secret_post` must send `client_id` and `client_secret` in an `application/x-www-form-urlencoded` body; authorization-code exchange must work without a PKCE verifier; and token-endpoint redirects must be refused or reliably detected and enforced by the integration boundary. Stop if any of these cannot be established. Selecting a different maintained library with the same boundary requires a short compatibility rationale and review.
- Do not execute the diagnostic probe or read real credentials. G1 does not block fake implementation, but live login is outside this slice.

## Error behavior

Return the exact `AuthError` variants defined above. Static public codes are:

- `CONFIG_INVALID`
- `CALLBACK_BIND_FAILED`
- `CALLBACK_TIMEOUT`
- `ACCESS_DENIED`
- `TOKEN_EXCHANGE_FAILED`
- `INVALID_TOKEN_RESPONSE`
- `CREDENTIAL_STORE_UNAVAILABLE`
- `CANCELLED`

Never propagate arbitrary provider descriptions or bodies. Browser-open failure cancels login. Exchange timeout/failure requires a fresh login and never reuses the code; this is the meaning of `TOKEN_EXCHANGE_FAILED` being retryable. Sink failure returns `{code:"CREDENTIAL_STORE_UNAVAILABLE",retryable:false}` and no authenticated status. Expected operational failures return `Result` values rather than escaping as raw exceptions.

## Tests

Use fake dependencies and ephemeral loopback test ports only. Cover:

- authorization encoding and exact scopes;
- wrong, missing, duplicate, unequal-length, and replayed state;
- duplicate code/error, code plus error, wrong host/path/method, and non-loopback config;
- callback arrival before browser-opening promise completion;
- valid user denial;
- occupied port, timeout, cancellation, and listener cleanup;
- exact code-exchange request and redirect refusal;
- missing refresh token, invalid expiry, malformed token response, and sink failure;
- provider/canary secret text absent from all diagnostics;
- every error code has its exact required `retryable` literal and static text mapping;
- zero Oura/network contact in automated tests.

Run the common deterministic verification from `plan.md`.

## Acceptance criteria

- A fake end-to-end login writes exactly one validated token set only after a valid matching callback.
- Every rejected callback makes zero token requests.
- No secret values are exported, logged, or printed.
- Listener and request resources close on success, failure, timeout, and cancellation.
- Package public exports compile and all common checks pass.
- No live/operator acceptance is claimed in this slice.

## Dependencies

Implemented Slice 1/domain exports. Slice 2 conventions may be reused where they are public and relevant. No dependency on MCP, agent, or G1.

## Open questions / gates

Only the required slice-start provider-scope and library compatibility verification. G1 applies to later live acceptance, not fake implementation.

## Stop conditions

Stop and request review rather than inventing provider behavior, hand-rolling OAuth token processing, broadening scopes without official evidence, adding a PKCE assumption, changing the redirect contract, weakening state validation, using the diagnostic probe as production code, introducing credential-storage fallback, or changing architecture. Stop if the maintained library cannot support the documented provider flow.

## Suggested commit boundary

`feat(oura): implement validated loopback OAuth flow`

Do not commit unless separately requested; never stage planning documents.

## Implementation-model handoff

Implement only this fake, bounded OAuth flow in a new `@ahp/oura-client` package. Verify current official protocol/scopes and the OAuth library first, then build the exact state machine and adversarial tests above. Use existing domain exports rather than recreating shared schemas. Do not add Keychain, refresh sessions, CLI, health endpoints, real login, or probe shortcuts. Stop on undocumented provider behavior or any required boundary change.
