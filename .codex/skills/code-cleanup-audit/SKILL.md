---
name: code-cleanup-audit
description: Audit a repository for architectural decay, AI-generated code smells, stale compatibility paths, dead abstractions, boundary violations, and cleanup candidates without modifying files. Use when the user asks to review code quality, find bad code, inspect AI-generated code, identify refactoring or cleanup opportunities, detect legacy leftovers, or produce a cleanup backlog that requires human confirmation before implementation.
---

# Code Cleanup Audit

## Overview

Use this skill to produce an evidence-backed cleanup audit only. The output is a backlog of suspected or confirmed problems for human review, not an implementation plan that silently edits code.

## Non-Negotiable Guardrails

- Do not modify files.
- Do not call `apply_patch`, formatters with write mode, generators, codemods, install commands, migration commands, or any command whose purpose is to change the workspace.
- Do not create branches, commits, pull requests, or issue tickets unless the user explicitly asks after reviewing the audit.
- If the user asks for fixes before seeing the audit, first produce findings and ask which items to implement.
- If a command unexpectedly changes files, stop, report the changed paths, and ask how to proceed.
- Preserve unrelated dirty worktree changes; treat them as user-owned.

## Audit Workflow

1. Establish repository context:
   - Read `AGENTS.md` first.
   - Read architecture and convention docs that directly govern the touched codebase, especially dependency boundaries, ADRs, and package conventions.
   - Run `git status --short` and note existing dirty files.
   - Inventory apps/packages with read-only commands such as `find`, `rg --files`, `pnpm -r list --depth -1`, and package manifest reads.

2. Build a map before judging:
   - Identify package boundaries, public exports, app entry points, runtime adapters, shared schemas, tests, and docs.
   - Trace imports through package names, not only filenames.
   - Compare implementation structure against documented allowed dependencies.
   - Prefer `rg` over slower search tools.

3. Inspect for cleanup categories:
   - Architecture violations: forbidden imports, cross-package relative imports, app-layer logic in shared packages, runtime-specific code in core/shared, browser-unsafe code in web/client/shared.
   - Stale compatibility: deprecated fields, fallback branches, migration shims, legacy aliases, duplicate old/new APIs, TODOs that preserve obsolete behavior, no-op adapters, unused feature flags.
   - AI-generated code smells: over-broad abstractions, fake extensibility, duplicated helpers, inconsistent naming, hand-rolled utilities where a project utility exists, speculative layers, uncalled code, verbose comments explaining obvious code, guessed data shapes.
   - Type and schema weakness: `any`, unsafe casts, unchecked `unknown`, interfaces where runtime validation is required, schema/type drift, missing boundary parsing.
   - Error and runtime behavior smells: swallowed errors, broad `catch`, impossible states represented as optional fields, missing cancellation/timeout handling, fragile env assumptions.
   - Test and validation gaps: core behavior without tests, snapshots masking behavior, tests that only assert mocks, missing negative cases for boundary rules.
   - Documentation drift: docs or AGENTS rules contradicted by code, public API exports not reflected in docs, stale startup/quality commands.

4. Validate suspected issues:
   - Read surrounding code and tests before reporting.
   - Run read-only validation where useful: `pnpm lint`, `pnpm typecheck`, `pnpm test`, focused Vitest commands, `pnpm build` only when build behavior is relevant.
   - Use existing ESLint boundary rules as evidence when available.
   - Distinguish confirmed problems from cleanup candidates that need product or architectural judgment.

5. Report without fixing:
   - Lead with findings ordered by severity.
   - Include file path and line or precise code location for each finding.
   - State the violated rule or smell, why it matters, evidence, confidence, and suggested cleanup direction.
   - Mark every item as one of: `confirmed`, `likely`, or `needs human decision`.
   - Include "Do not modify until confirmed" language when handing off.

## Severity Standard

- `Critical`: Can break runtime behavior, violate security/privacy boundaries, corrupt data, or cause CI/build failure.
- `High`: Violates documented architecture, creates wrong package dependency direction, or preserves misleading/dead public API that future agents will copy.
- `Medium`: Increases maintenance cost through duplication, stale compatibility, weak validation, or untested shared behavior.
- `Low`: Local readability or consistency issue with limited blast radius.

Do not report pure preference, cosmetic style, or speculative rewrites unless tied to a concrete maintenance, correctness, boundary, or future-agent-copying risk.

## Recommended Commands

Use commands like these as applicable. Keep them read-only.

```bash
git status --short
find apps packages docs -maxdepth 3 -type f | sort
rg --line-number "TODO|FIXME|deprecated|legacy|compat|shim|fallback|no-op|noop|any\\b|as unknown|as any" apps packages docs
rg --line-number "from ['\"]\\.\\./\\.\\./|from ['\"]\\.\\./\\.\\./\\.\\./|@pragma/(client|server|core|runtime)" apps packages
pnpm -r list --depth -1
pnpm lint
pnpm typecheck
pnpm test
```

Before running expensive repository-wide commands, prefer focused reads and explain why the command is useful.

## Output Format

Return:

1. Findings
   - Severity
   - Status: `confirmed`, `likely`, or `needs human decision`
   - Location
   - Problem
   - Evidence
   - Cleanup direction, without editing code

2. Cleanup backlog
   - Group related findings into reviewable batches.
   - Call out which batches are safe mechanical cleanup versus architecture decisions.

3. Non-findings and constraints
   - Mention important suspected issues that were checked and rejected.
   - Mention commands run and commands intentionally skipped.

4. Human confirmation needed
   - List the exact decisions needed before any code changes.
