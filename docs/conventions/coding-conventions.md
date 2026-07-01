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
