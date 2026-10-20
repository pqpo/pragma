# ADR 040: DSL-defined Built-in Agents package

## Status

Superseded in part by [ADR 052](./052-synchronous-skill-validation.md)

## Context

Pragma, Memory Curator, Store Revision, Skill Revision, and Evaluation Judge are the five product-level
system Agents. Their behavior was split between one reusable package and Desktop-specific direct
Expert definitions, which would require every future Host to reconstruct the same prompts,
validation, and revision rules.

## Decision

Use `@pragma/built-in-agents` for the built-in Agents and define them as static resources using the
current Pragma DSL version exported by the Interpreter. The package owns their canonical refs, compilation,
portable contracts, prompts, structured-output parsing, Memory curation, Store/Skill revision
rules, Skill validation, and pure revision state machines.

Each Agent keeps a separate invocation port. They are not modeled as one workflow and Hosts are
not required to expose one common calling convention. Hosts own Runtime selection and execution,
permissions, Mission integration, persistence, scheduling, and UI. Pragma, Store Revision, and
Skill Revision remain visible and customizable through Studio, including their callable Expert,
ExpertTeam, and Flow tools. Store Revision keeps its locked system tools. Memory Curator
and Evaluation Judge remain hidden managed Agents selected through their owning
workflows.

Persistent identifiers and protocol strings are constructed through their authoritative runtime
schemas and remain stable across Host surfaces.

## Consequences

Hosts can compile the same Agent definitions and reuse product behavior while choosing
different execution and storage adapters. The package stays independent of Desktop, Server,
Client, concrete Runtime adapters, and UI frameworks. Browser consumers use only
`@pragma/built-in-agents/contracts`.

ADR 052 removed the former Skill Evaluation Agent in favor of deterministic validation and human review; it is not a sixth current built-in Agent.
