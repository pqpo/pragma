# Coding Conventions

## TypeScript

- Use strict TypeScript.
- Export runtime schemas for cross-process contracts.
- Derive DTO types from schemas instead of duplicating interfaces.
- Keep source files ESM-compatible.

## Packages

- Every package is private and `type: "module"`.
- Every package exposes `lint`, `typecheck`, `test`, `build`, and `clean`.
- Internal dependencies use `workspace:*`.
- Cross-package imports use `@pragma/*` package names.

## Boundaries

- Do not put shared logic in `apps`.
- Do not let Web import database or Agent packages.
- Do not let shared packages import Node, React, Fastify, Prisma, or Agent Runtime APIs.
- Define the target layer before creating a new package.

## Semantic Resource Identities

- Expert, ExpertTeam, Flow, Automation, Capability, ContextStore, RuntimeProfile, and Evaluation
  identities are exactly 16 lowercase Crockford Base32 characters: `0-9`, `a-h`, `j-k`, `m-n`,
  and `p-t`, `v-z`. The ambiguous letters `i`, `l`, `o`, and `u` are forbidden.
- Never treat a readable mnemonic as proof that a reserved or built-in ID is valid. Define every
  built-in semantic ref through the canonical runtime Schema at its declaration site so an invalid
  literal fails during module initialization and tests.
- A built-in identity must have an integration test at its first persisted or cross-process
  consumer boundary. A unit test that mocks that boundary is not sufficient.
- When an ID is used in both an unqualified and qualified form, keep one source literal and derive
  the canonical `<kind>:<id>` ref through the Schema. Do not maintain two unchecked strings.
- Background jobs must preserve a stable, bounded error code. Serialized validation errors and
  stack text are diagnostics, not error codes. Stable error codes use lowercase ASCII and match
  `[a-z][a-z0-9_.-]{0,199}`; normalize trustworthy external codes before persisting them.

## Background Pipeline Observability

- Capturing or publishing source Evidence is not equivalent to producing a derived record. UI copy
  and counters must name the exact pipeline stage they represent.
- A background job in `needs_attention`, an unavailable module, or an unprocessed quarantined item
  makes the owning subsystem degraded. The health API, logs, and user-facing status must expose the
  module and a stable latest error code.
- Retriable Evidence must remain available while a job needs attention. Changing the relevant
  configuration or installing a corrected build must be able to wake the preserved job without
  rerunning the source task.

## Runtime Adapters

- Runtime usage events are snapshots unless explicitly documented as deltas.
- Follow [Runtime Usage Accounting](./runtime-usage-accounting.md) when parsing Claude Code, Codex, or local transcript/session usage.
