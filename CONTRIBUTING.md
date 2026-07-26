# Contributing to Pragma

Thank you for helping build Pragma. The project aims to provide an open, runtime-neutral foundation
for composing experts, flows, tools, models, and agent harnesses into reliable AI-native ways of
working.

## Before You Start

Please read:

- [AGENTS.md](./AGENTS.md) for repository rules and architecture boundaries.
- [Module boundaries](./docs/architecture/module-boundaries.md).
- [Coding conventions](./docs/conventions/coding-conventions.md).
- [Governance](./GOVERNANCE.md).
- [Code of Conduct](./CODE_OF_CONDUCT.md).

For a substantial feature, new package, persistent schema change, public protocol change, or
cross-layer dependency, open an issue before implementation. Describe the problem, intended users,
alternatives, compatibility impact, and verification plan.

## License Status

Pragma is distributed under the [Pragma Source Available License 1.0](./LICENSE). It is a custom
source-available license, not the standard Apache License 2.0 or an OSI-approved open-source license.

By intentionally submitting a contribution for inclusion in Pragma, you agree to the contribution
grant in Section 2.7 of the license. If a communication or patch is not intended as a contribution,
mark it conspicuously as `Not a Contribution` before submitting it.

Do not submit code, documentation, assets, or other material unless you have the right to grant those
permissions.

## Development Setup

Requirements:

```text
Node.js >= 22
pnpm 10.12.1
```

Install dependencies:

```bash
pnpm install
pnpm -r list
```

Run the standard quality suite:

```bash
pnpm check
pnpm build
```

`pnpm check` runs lint, typecheck, and tests. CI also runs the build.

## Architecture Rules

The repository uses a pnpm workspace and strict package boundaries. In particular:

- `shared` remains runtime-neutral and browser-safe.
- `client` does not depend on `server` or `core`.
- `core` does not depend on concrete runtimes, apps, React, or Next.js.
- concrete runtime implementations remain isolated under `packages/runtime/*`.
- plugins do not depend on apps, server implementations, clients, or concrete runtimes.
- cross-package imports use `@pragma/*` package imports.
- internal dependencies use `workspace:*`.
- source-relative TypeScript imports include the `.ts` extension.

Do not add compatibility layers, deprecated fields, or empty abstractions without long-term value.
Breaking changes are acceptable when they produce a clearer architecture and all callers, tests,
schemas, and documentation are updated together.

## Making a Change

1. Confirm the change belongs in the target layer.
2. Search for existing APIs and patterns before introducing a new abstraction.
3. Keep the change focused; do not mix unrelated cleanup into the same pull request.
4. Add or update runtime schemas when data crosses a process or persistence boundary.
5. Add tests proportional to the behavior and risk.
6. Update documentation and ADRs when a public boundary or architectural decision changes.
7. Run the relevant package checks, followed by `pnpm check`.
8. Run `pnpm build` when the change affects packages, exports, or application entry points.

Persistent state changes must follow
[ADR 019](./docs/adr/019-versioned-persistent-state-migrations.md). A schema version bump without
the adjacent migration, historical fixtures, recovery tests, and future-version rejection tests is
not complete.

## Pull Requests

Pull requests should:

- explain the user or architecture problem;
- describe the chosen solution and important alternatives;
- list verification performed;
- call out breaking changes, migrations, security effects, and follow-up work;
- avoid generated output such as `dist`, `.next`, `.turbo`, coverage, or `node_modules`;
- pass CI before merge.

Use the repository pull request template. Reviewers may request an ADR when the decision has
long-term architectural consequences.

## Reporting Bugs and Requesting Features

Use the GitHub issue templates and include the smallest reproducible example possible. Do not put
credentials, private workspace content, personal data, or unredacted logs in a public issue.

Security vulnerabilities must follow [SECURITY.md](./SECURITY.md), not the public issue tracker.

## Community

Be respectful, evidence-driven, and explicit about uncertainty. Participation in the repository is
governed by the [Code of Conduct](./CODE_OF_CONDUCT.md).
