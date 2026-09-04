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
