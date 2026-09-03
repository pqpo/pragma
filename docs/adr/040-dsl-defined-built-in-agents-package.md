# ADR 040: DSL-defined Built-in Agents package

## Status

Accepted

## Context

Pragma, Memory Curator, Store Revision, Skill Revision, Skill Evaluation, and Evaluation Judge are product-level
system Agents. Their behavior was split between one reusable package and Desktop-specific direct
Expert definitions, which would require every future Host to reconstruct the same prompts,
validation, and revision rules.

## Decision

Use `@pragma/built-in-agents` for all six Agents and define them as static resources using the
current Pragma DSL version exported by the Interpreter. The package owns their canonical refs, compilation,
portable contracts, prompts, structured-output parsing, Memory curation, Store/Skill revision
rules, Skill validation, and pure revision state machines.

Each Agent keeps a separate invocation port. They are not modeled as one workflow and Hosts are
not required to expose one common calling convention. Hosts own Runtime selection and execution,
permissions, Mission integration, persistence, scheduling, and UI. Pragma remains visible and
customizable through its existing product surface. Store Revision is exposed as a managed Mission
executor with locked system tools; the remaining service Agents are selected through their owning
workflows.

Persistent identifiers and protocol strings are constructed through their authoritative runtime
schemas and remain stable across Host surfaces.

## Consequences

Hosts can compile the same six Agent definitions and reuse product behavior while choosing
different execution and storage adapters. The package stays independent of Desktop, Server,
Client, concrete Runtime adapters, and UI frameworks. Browser consumers use only
`@pragma/built-in-agents/contracts`.
