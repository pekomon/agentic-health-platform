# Agentic Health Platform

An experimental health and training platform exploring production-oriented
agentic engineering, health data integrations, reusable SDKs, MCP-based tool
use, and evidence-backed training recommendations.

The first milestone focuses on using Oura health data, explicit user goals,
and current context to produce a grounded daily training recommendation.

The project is designed around a few core principles:

- deterministic health-data ingestion and normalization
- explicit provenance for data used in recommendations
- MCP-based tool access for agent workflows
- structured and testable agent outputs
- privacy-aware handling of health data
- synthetic data for tests and evals
- reusable SDK and platform boundaries
- future multiplatform clients for iOS, Android, and web

## Initial scope

The first version will focus on a single-user development workflow using Oura
data from the previous 14 days.

The agent will produce a structured daily training recommendation based on:

- sleep and recovery information
- recent training history when available
- an explicit user training goal
- allowed training types
- available training time
- current local time and usual bedtime

The initial interface will be a CLI.

## Planned evolution

Future milestones may include:

- Polar integration
- normalized health data across multiple providers
- longer-term adaptive training plans
- user feedback and recommendation adaptation
- native Swift and Kotlin SDKs
- SwiftUI and Android showcase applications
- persistent health history and trend analysis
- web-based health visualization
- optional cloud infrastructure

The architecture is intended to allow additional health data providers to be
added without coupling the core health domain to a specific vendor.

## Health and medical disclaimer

This project is intended for wellness, fitness, training guidance, and software
engineering experimentation.

It is not a medical device and is not intended to provide medical advice,
diagnosis, or treatment.

## Status

Early development.

## Local environment

This repo uses direnv for project-scoped development secrets. The committed
`.envrc` loads `OPENAI_API_KEY` and `OURA_CLIENT_SECRET` from macOS Keychain
through the local `keychain` helper.

Run `direnv allow` after reviewing `.envrc`. Use `.envrc.local` for
machine-specific overrides; it is intentionally gitignored.

## Development commands

```text
npm ci
npm run typecheck
npm test -- --run
npm run build
```

## Synthetic recommendation CLI

After building, run a recommendation over one of the bundled fabricated scenarios:

```text
npm run health -- recommend --synthetic well_recovered_runner --model <model-id>
```

An explicit `OPENAI_API_KEY` is required for an actual model run, which may incur
model charges. The other bundled scenario IDs are `poor_sleep_low_recovery`,
`strength_goal_good_recovery`, `late_evening_low_recovery`, and `missing_data`.
Add `--json` for the structured result. When piping JSON, use
`npm run --silent health -- recommend --synthetic well_recovered_runner --model <model-id> --json`
so npm does not print its script banner.

The command is marked **SYNTHETIC** and uses fabricated health data. It is not
live Oura advice. Plain `health recommend` is blocked while live Oura agent
integration remains subject to separate approval and implementation.
