# ADR 040: DSL-defined Built-in Agents package

## Status

Accepted

## Context

Pragma, Memory Curator, Store Revision, Skill Revision, and Skill Evaluation are product-level
system Agents. Their behavior was split between one reusable package and Desktop-specific direct
Expert definitions, which would require every future Host to reconstruct the same prompts,
validation, and revision rules.

## Decision

Rename `@pragma/default-agent` to `@pragma/built-in-agents` and define all five Agents as static
`pragma/v3` DSL resources in that package. The package owns their canonical refs, compilation,
portable contracts, prompts, structured-output parsing, Memory curation, Store/Skill revision
rules, Skill validation, and pure revision state machines.

Each Agent keeps a separate invocation port. They are not modeled as one workflow and Hosts are
not required to expose one common calling convention. Hosts own Runtime selection and execution,
permissions, Mission integration, persistence, scheduling, and UI. Pragma remains visible and
customizable through its existing product surface; the other four Agents remain hidden and
non-customizable.

Existing persistent identifiers and protocol strings remain unchanged, including
`default-agent-option`, `binding:pragma.default-agent-host`, Mission origins, state paths, and
schema versions. Historical ADRs retain the package name that was current when they were written.

## Consequences

Future Hosts can compile the same five Agent definitions and reuse product behavior while choosing
different execution and storage adapters. The package stays independent of Desktop, Server,
Client, concrete Runtime adapters, and UI frameworks. Browser consumers use only
`@pragma/built-in-agents/contracts`.
