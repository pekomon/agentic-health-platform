# Architecture

## Purpose

Agentic Health Platform is a production-oriented health and training platform for building evidence-backed agentic recommendations on top of wearable and user-provided health context.

The project is intentionally designed as a reusable platform and SDK foundation rather than as a single application.

The primary engineering goals are:

- clean provider boundaries
- provider-neutral health domain models
- explicit provenance for health observations
- semantic tool interfaces for agents
- evidence-backed agent outputs
- deterministic evaluation of agent behavior
- reusable SDK surfaces
- support for multiple clients and providers over time

The system is a wellness and training product. It is not intended to diagnose disease, provide medical treatment, or act as a medical device.

---

## Architectural principles

### Platform first

Core functionality belongs in reusable packages and SDKs.

Applications are consumers of the platform rather than the place where domain logic lives.

Initial development focuses on the platform core and a CLI showcase. Native iOS, Android and web clients may be added later without changing the core domain model.

### Provider-neutral core

Wearable providers expose different concepts, names and scoring systems.

The core domain therefore models normalized health observations where normalization is meaningful, while preserving provider-specific information when semantics cannot safely be generalized.

Provider-specific concepts must not be silently reinterpreted as equivalent cross-provider metrics.

### Evidence before explanation

Agent recommendations must be grounded in observations available through tools.

Recommendations must carry structured evidence or provenance sufficient to determine which observations influenced the result.

The model must not invent measurements, health observations, heart-rate zones or provider scores.

### Deterministic boundaries around probabilistic behavior

Parsing, normalization, validation and tool input/output contracts should be deterministic.

The agent is responsible for reasoning over those deterministic inputs, not for extracting or guessing raw provider data.

### Semantic agent tools

Agent tools should represent meaningful domain operations rather than exposing raw storage or provider APIs.

Prefer tools such as:

- `get_user_profile`
- `get_current_context`
- `get_sleep_history`
- `get_recovery_history`
- `get_recent_training`

Avoid broad tools such as `get_all_health_data`.

Tool responses should be small enough for grounding and debugging while retaining relevant provenance.

---

## Repository structure

The project is intended to evolve as a monorepo.

A likely structure is:

```text
specs/
  architecture.md
  v0.1.md

packages/
  health-domain/
  oura-client/
  health-tools/

services/
  health-agent/

fixtures/
  synthetic/

sdk/
  swift/
  kotlin/

apps/
  ios/
  android/
  web/
```

This structure is directional rather than a requirement to scaffold every directory immediately.

Only create packages and applications when they are required by the current implementation slice.

---

## Health domain

The core domain must not expose Oura-specific API response models as its public abstraction.

A normalized daily snapshot may conceptually look like:

```ts
type DailyHealthSnapshot = {
  date: LocalDate;
  sleep?: SleepSummary;
  recovery?: RecoverySummary;
  activity?: ActivitySummary;
  sources: DataSource[];
  providerData?: {
    oura?: unknown;
    polar?: unknown;
  };
};
```

Provider-specific values may remain in `providerData` or another explicitly provider-scoped structure when normalization would lose important semantics.

### Provenance

Normalized observations should retain information about their origin.

A metric may conceptually use a representation such as:

```ts
type Observation<T> = {
  value: T;
  source: DataSource;
  measuredAt?: string;
  unit?: string;
  metric: string;
};
```

The exact shape may evolve during implementation.

The important requirement is that normalized data does not become detached from its source.

---

## User profile

The agent may use explicit user goals and constraints.

Initial training goals:

```ts
type TrainingGoal =
  | "GENERAL_FITNESS"
  | "ENDURANCE"
  | "STRENGTH"
  | "MUSCLE_GAIN"
  | "WEIGHT_MANAGEMENT"
  | "RECOVERY"
  | "OTHER";
```

`OTHER` may include a short user-provided custom goal.

User preferences may also constrain allowed training types.

Initial training types:

```ts
type TrainingType =
  | "RUNNING"
  | "WALKING"
  | "CYCLING"
  | "STRENGTH"
  | "MOBILITY"
  | "REST";
```

---

## Current context

Health measurements alone are insufficient for a useful daily recommendation.

The system may also expose contextual information such as:

- current local time
- planned or usual bedtime
- available training time
- explicitly configured user constraints

Context should be available through a semantic tool rather than being embedded implicitly in the agent prompt.

---

## Recommendation model

A daily recommendation should be structured data rather than free-form text.

Conceptually:

```ts
type DailyTrainingRecommendation = {
  activity: TrainingType;
  intensity: "REST" | "EASY" | "MODERATE" | "HARD";
  durationMinutes?: number;
  targetHeartRateZone?: {
    minZone: number;
    maxZone: number;
  };
  rationale: string;
  evidence: Evidence[];
  confidence: number;
};
```

Heart-rate targets are optional.

The system must not manufacture heart-rate zones or BPM values when they are not available from trusted user/provider data or explicitly configured calculations.

---

## Oura provider

Oura is the first wearable provider.

The provider integration should have a clear boundary between:

1. Oura authentication and transport
2. Oura API response models
3. normalization into the platform health domain

Provider transport types should not leak throughout the application.

### Authentication

The initial Oura integration uses OAuth 2.0 authorization-code flow with a localhost callback for local development.

Authentication responsibilities include:

- constructing the authorization request
- receiving and validating the callback
- exchanging the authorization code
- securely storing tokens
- refreshing tokens when required
- keeping credentials and tokens out of source control and logs

A local diagnostic OAuth probe currently exists during development as a known-good reference implementation. It is not part of the production architecture.

The production implementation should reproduce the validated behavior through a proper provider auth module.

---

## Oura data and AI boundary

Oura API access and AI use must respect the current Oura developer agreement and platform requirements.

The architecture must not assume that health data obtained through the standard Oura REST API may automatically be forwarded to an external LLM.

Before implementing an Oura-to-agent data path, verify the current Oura requirements for AI usage.

If Oura requires its MCP server for AI/LLM access, the architecture should keep these paths separate:

```text
Oura REST API
    |
    +--> local/provider SDK functionality
    +--> normalization where legally permitted

Oura MCP Server
    |
    +--> agent-accessible Oura data
```

Our own MCP tools may expose non-Oura data such as:

- user profile
- current context
- future supported providers
- application-owned state

No architecture decision should bypass provider contractual restrictions for convenience.

---

## MCP

MCP is a first-class architectural boundary for agent tool use.

The agent should interact with health information through explicit semantic tools rather than being handed a large serialized health record.

Tool contracts should:

- be typed
- return bounded amounts of data
- preserve provenance
- expose missing data explicitly
- avoid introducing medical interpretations
- support deterministic testing

The same domain layer should be usable independently of the agent.

---

## Agent

The initial agent produces one daily training recommendation.

Its responsibilities are:

- decide what health/context information is relevant
- call the necessary tools
- reason about recovery, sleep, goals and current context
- produce a structured recommendation
- cite evidence from available observations
- express uncertainty when evidence is incomplete

The agent must not:

- invent health measurements
- silently infer unavailable medical conditions
- give diagnostic or treatment advice
- claim stronger certainty than the available evidence supports

The initial implementation is expected to use the OpenAI Agents SDK.

---

## Evaluation

Agent behavior must be evaluated using synthetic fixtures.

Real personal health data must not be committed to the repository or used as shared evaluation fixtures.

Initial fixture scenarios should include examples such as:

```text
well_recovered_runner.json
poor_sleep_low_recovery.json
strength_goal_good_recovery.json
late_evening_low_recovery.json
missing_data.json
```

Important behavioral assertions include:

- poor recovery should not produce an unjustified hard workout
- late-evening context should influence training intensity when appropriate
- missing data must not be invented
- recommendations must be backed by available evidence
- uncertainty should increase when relevant evidence is missing

Evaluation should test both structured outputs and tool-use behavior.

---

## Persistence

Persistent storage may be introduced when required.

The domain model must not depend directly on a particular storage technology.

Before storing provider health data, retention and caching requirements from the provider agreement must be verified.

Local SQLite remains a possible implementation option for application-owned or legally cacheable data, but it is not an architectural requirement for the first implementation slice.

---

## Security and privacy

Health information is sensitive application data.

The platform should follow these principles:

- least-privilege OAuth scopes
- no credentials or tokens in source control
- no health data in logs unless explicitly sanitized
- synthetic data in tests and examples
- clear provider boundaries
- explicit data retention decisions
- secrets stored using appropriate local or platform credential storage

Agent tracing and observability must not casually capture raw personal health data.

---

## Future architecture

The architecture should allow future addition of:

- Polar and other wearable providers
- Swift SDK
- Kotlin SDK
- iOS application
- Android application
- persistent conversational state
- adaptive training plans
- feedback loops
- cloud-hosted services
- web dashboard
- multi-user authentication

These are not required for v0.1 and must not complicate the first implementation unnecessarily.

