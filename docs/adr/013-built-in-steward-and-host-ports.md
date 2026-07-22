# ADR 013: Built-in Steward and Host Ports

## Status

Superseded by [ADR 014](./014-desktop-home-mission-entry-and-system-experts.md)

## Context

Pragma needs a built-in conversational Steward that can create or update Experts, ExpertTeams, and
Flows, submit work, inspect task state, and continue across application restarts. Desktop is the
first host, but the same capability must later run in a Web application whose persistence and task
control live behind server/database APIs.

The Steward must not learn application-specific storage internals. Pragma DSL is already the
canonical, validated representation for authored resources, and Runtime managed tools already have
approval and MCP projection semantics.

## Decision

Introduce `@pragma/steward` as a standalone Node package. It owns:

- a portable `pragma/v2` Steward Expert and its capability declarations;
- the built-in `author-pragma-dsl` Skill containing DSL authoring knowledge;
- application-neutral DSL project, task, and state repository ports;
- managed tools wrapping those ports;
- one durable Steward ExpertSession and fixed Steward workspace;
- browser-safe request, response, state, chat, and approval contracts.

The Steward authors resource changes only as complete YAML documents. A host first prepares a
validated change-set and then commits it using project-revision compare-and-swap. Updating an exact
resource version creates a new project revision; existing Missions remain pinned to the revision
with which they started.

Host applications choose and register the Runtime, implement persistence and task ports, and render
approval UI. Direct TypeScript ports are the application integration boundary. Managed tools remain
available to Codex and Claude through the existing Execution MCP Gateway, so no Steward-specific CLI
or MCP server is introduced.

Desktop exposes the Steward only through Home for now. It uses local project and Mission stores,
persists state below `~/.pragma/state/steward`, and uses the fixed workspace
`~/.pragma/workspaces/steward`. A future Web host can reuse the package by providing server-backed
ports and its own transport adapter.

Home defaults a new Steward Session to the PI Runtime. Model and thinking-level selection belong to
each durable prompt, so they may change between turns without replacing the Runtime Context. A
Runtime change closes the current Session and therefore requires an explicit context-loss warning.
Desktop blocks the first prompt and deep-links to Model Provider settings when no provider is
configured.

## Consequences

- DSL syntax and authoring policy are versioned with the Steward Skill instead of duplicated in a
  system prompt or Desktop code.
- Desktop remains a composition and persistence host; it does not implement a second Agent.
- Mutating tools pass through Core's durable approval boundary.
- Adding a new host requires adapters, not changes to Steward behavior or DSL.
- A global floating launcher is intentionally deferred; Home is the only current product entry.
