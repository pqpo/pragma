# ExpertMesh

ExpertMesh is a long-term harness for a multi-expert Agent orchestration system. Phase 0 only creates the engineering foundation: package boundaries, application entry points, TypeScript strict mode, lint rules, tests, build tasks, and CI.

## Directory Layout

```text
apps/
  web/       Next.js UI composition layer
  server/    Fastify HTTP API entry
  worker/    Node worker entry
packages/
  shared/    Cross-runtime pure contracts, domain, and utilities
  client/    Browser/client-facing SDK
  server/    Node server infrastructure boundaries
  agent/     Node-only Agent execution boundaries
  tooling/   Shared ESLint and TypeScript config packages
docs/        Architecture notes, ADRs, and conventions
infra/       Infrastructure placeholders
```

## Dependency Boundaries

Allowed dependency direction:

```text
shared <- client/server <- agent <- apps
```

Rules:

- Do not put shared code directly in `apps`.
- Do not let Web directly access database or Agent packages.
- Do not let shared packages depend on Node, React, database, Fastify, or Agent Runtime APIs.
- Do not import across packages with relative paths. Use package imports such as `@expertmesh/contracts`.
- Define a new package's layer before adding it.

## Local Setup

```bash
pnpm install
pnpm -r list
```

## Start Apps

```bash
pnpm --filter @expertmesh/server dev
pnpm --filter @expertmesh/web dev
pnpm --filter @expertmesh/worker dev
```

The server exposes `GET /health` on port `3001`.

## Common Commands

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm check
```

## Adding Packages

Every package must be private, ESM, use `workspace:*` for internal dependencies, expose `lint`, `typecheck`, `test`, `build`, and `clean`, and extend the shared TypeScript config.

## Prohibited In Phase 0

- Expert Agent implementations
- Playbook orchestration
- Runtime adapters beyond interfaces
- Database models, Prisma, Redis, queues, or migrations
- Authentication
- MCP, Skill, Hook, or Plugin integration
- Relative cross-package imports

## Phase 0 Acceptance

- pnpm workspace resolves all apps and packages.
- Turborepo runs `lint`, `typecheck`, `test`, and `build`.
- Web, Server, and Worker start independently.
- Server returns `{ "service": "server", "status": "ok" }` from `/health`.
- Web displays `ExpertMesh Web Ready` and reads server health.
- ESLint blocks illegal cross-layer imports.
