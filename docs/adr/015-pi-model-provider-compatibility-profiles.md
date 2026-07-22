# ADR 015: PI Model Provider Compatibility Profiles

## Status

Accepted.

## Context

OpenAI-compatible endpoints share an HTTP shape but do not share one request contract. In
particular, support for `developer` messages, reasoning controls, token-limit fields, tool strict
mode, and provider-specific thinking payloads differs across providers and models. Treating every
reasoning model as modern OpenAI caused PI to send a `developer` message to endpoints that only
accept `system`, returning HTTP 400 before a Desktop Mission could start.

Provider payload details cannot live in `@pragma/shared` or `@pragma/core`: they are PI-specific,
and Codex or Claude Code must remain free to expose their own native model behavior.

## Decision

- Shared model metadata declares only runtime-neutral capabilities: whether the model reasons,
  which canonical thinking levels are user-selectable, the optional default level, and an opaque,
  versioned compatibility-profile ID.
- `@pragma/runtime-pi` owns the PI built-in provider catalog and converts its exact model metadata
  into the shared representation. Core retains only the `ModelProviderDirectory` interface.
- PI owns a versioned compatibility-profile registry. Profiles translate canonical thinking levels
  into PI's provider-specific `compat`, role, thinking, and token-field behavior.
- Exact PI built-in model metadata is the automatic source of truth. When no exact built-in model
  exists, PI selects a conservative provider profile. An explicit provider profile overrides that
  automatic choice, and an explicit model profile overrides the provider profile.
- Desktop exposes the profile registry as advanced provider- and model-level settings. Normal users
  keep the automatic selection; the UI never exposes raw PI request fields.
- Desktop connection verification performs a minimal request through the configured PI runtime,
  including a system prompt and the selected thinking mode. It therefore verifies the same request
  transformation used by Missions instead of a parallel hand-written HTTP probe.
- Desktop Model Provider storage advances from schema version 3 to 4. Version 3 is deliberately not
  migrated because its raw thinking maps cannot be interpreted reliably; Desktop offers to archive
  the old file and requires the provider to be configured again.

## Consequences

- Adding or correcting a provider is a PI profile/catalog change, not a shared-schema or Desktop
  conditional branch.
- Profile IDs are versioned so changing wire semantics requires a new ID instead of silently
  mutating persisted configuration.
- Unknown OpenAI-compatible services default to `system` messages and omit non-standard reasoning
  parameters until the user selects a more specific profile.
- Codex and Claude Code runtimes are unaffected by PI compatibility rules.
