# ADR 003: Memory System Evidence-based Distillation

## Status

Proposed.

## Context

Pragma already separates memory into four first-class categories:

- `Task Memory`
- `Experience Memory`
- `Fact Memory`
- `Skill Memory`

This semantic split is useful and should remain. However, the current Agent-facing operation surface is still too heavy:

- `task`, `experience`, and `fact` each expose their own dedicated tools.
- `skill` primarily works through context projection and runtime hooks.
- The interaction model is inconsistent across memory types.
- `experience`, `fact`, and `skill` all behave like distilled knowledge from runtime evidence, but are still modeled as categories the Agent can directly write to by default.

This creates several problems:

- The Agent must reason about too many memory tools.
- Memory governance is pushed back onto the model.
- The provenance of `experience`, `fact`, and `skill` is less uniform than it should be.
- Summary generation, retrieval, and promotion boundaries are harder to keep coherent.

## Decision

Pragma will restructure the Memory System into two layers:

1. `Task Memory` remains a distinct runtime collaboration layer with explicit write operations.
2. `Experience`, `Fact`, and `Skill` become evidence-based distilled memory views built from a shared evidence layer, rather than categories the Agent writes to directly by default.

The default Agent interaction model becomes:

- explicit write access for `Task Memory`
- unified read access through `ContextSystem`
- automatic distillation for `Experience`, `Fact`, and `Skill`

## Principles

- `Task Memory` is operational memory.
- `Experience`, `Fact`, and `Skill` are distilled memory.
- Distilled memory shares a common evidence foundation.
- Agents should directly write only the memory that cannot be recovered reliably from runtime evidence.
- `ContextSystem` remains the default read surface for memory views.
- `MemorySystem` is responsible for distillation, governance, summary projection, and retrieval strategy, not for duplicating generic read tools.

## Architecture

The new layering is:

```text
Runtime / Session / Tool / Stream Evidence
        ↓
     Evidence Store
        ↓
 ┌────────┼────────┐
 ↓        ↓        ↓
Experience Fact    Skill
Distiller Distiller Distiller
 ↓        ↓        ↓
Experience Fact    Skill
View       View    View
        ↓
 Memory Summary Projector
        ↓
 memory context namespace
```

In parallel:

```text
Task Memory
```

`Task Memory` remains outside the distilled pipeline because it is a live collaboration workspace rather than a derived knowledge artifact.

## Responsibilities

### Task Memory

`Task Memory` stores the working state of the current task, run, or session.

It exists for:

- shared and private collaboration state
- handoff notes
- todos and progress
- intermediate decisions
- unresolved questions

It must continue to support runtime semantics such as:

- `shared` and `private` visibility
- revision-aware updates
- patch-style changes
- multi-Agent coordination

Archived task memory may become an evidence source, but task memory itself is not the long-term knowledge layer.

### Evidence Store

The evidence layer is the canonical upstream source for distilled memory.

Typical sources include:

- session transcripts
- tool calls
- stream events
- task submissions
- session finalization artifacts

The evidence layer must be:

- auditable
- replayable
- traceable to runtime sources
- reusable for re-distillation

### Experience Distiller

The Experience distiller answers:

```text
What happened?
```

It extracts:

- process summaries
- execution paths
- failures
- recoveries
- run/session/tool usage patterns

It does not carry the burden of stable truth governance.

### Fact Distiller

The Fact distiller answers:

```text
What is currently believed to be true?
```

It extracts stable conclusions from evidence and attaches governance metadata such as:

- `confidence`
- `observedAt`
- `verifiedAt`
- `reviewAt`
- `invalidatedAt`
- conflict or supersession relationships

### Skill Distiller

The Skill distiller answers:

```text
How should this kind of problem be handled next time?
```

It extracts reusable methods such as:

- recommended paths
- anti-patterns
- failure modes
- recovery playbooks

It continues to reference runtime evidence rather than replacing it.

### Memory Summary Projector

The summary projector generates the always-on memory guide exposed to the model.

Its responsibilities are:

- provide a compact `memory` summary
- describe what memory domains exist
- explain when to inspect task, experience, fact, or skill views
- direct the Agent toward the right context items for follow-up reading

The summary is a usage guide and retrieval surface, not a raw dump of all stored records.

## Agent-facing Tool Surface

The default memory tool surface should be reduced.

### Keep by Default

- `append_task_memory`
- `patch_task_memory` or an equivalent task-update operation
- the existing `ContextSystem` read tools:
  - `list_expert_context`
  - `read_expert_context`
  - `search_expert_context`

### Remove by Default

- `append_experience_memory`
- `write_fact_memory`
- `update_fact_memory`
- category-specific `list/get_*_memory` read tools

### Rationale

`Task Memory` cannot be reconstructed reliably from passive runtime evidence alone, so it needs explicit write operations.

By contrast, `Experience`, `Fact`, and `Skill` are better treated as governed interpretations over a shared evidence base. If Agents write them directly by default:

- provenance becomes less consistent
- governance quality degrades
- summary and retrieval become noisier
- the model takes on responsibilities that should belong to the Memory System

## Relationship to ContextSystem

`ContextSystem` remains the default read surface for memory.

This means:

- the Memory System should project readable memory artifacts into context
- the Agent should use context tools to inspect memory
- the Memory System should not duplicate generic `read` or `search` tools unless a future constraint proves that context projection is insufficient

In practice, the Memory System should focus on:

- evidence capture
- distillation
- governance
- summary generation
- context projection

## Relationship to ADR 002

This ADR preserves the main semantic conclusions of ADR 002:

- the four memory categories remain meaningful
- the system should not collapse final memory artifacts into a single weakly-typed record
- `Task`, `Experience`, `Fact`, and `Skill` still answer different questions

This ADR changes the interaction model:

- `Experience`, `Fact`, and `Skill` are no longer treated as peer categories that the Agent writes directly by default
- they are treated as distinct distilled views over a shared evidence base

## Consequences

### Positive

- The Agent sees fewer tools.
- The interaction model becomes more consistent.
- `Experience`, `Fact`, and `Skill` gain a common provenance model.
- Replay, re-distillation, and summary rebuilding become easier.
- The Memory System becomes more governable over time.

### Cost

- A new `Evidence Store` abstraction must be introduced.
- The current promotion pipeline must evolve into a distillation pipeline.
- Existing direct-write flows for `experience` and `fact` need migration.
- Documentation, examples, and tests need to be updated.

## Migration Plan

### Phase 1

- Introduce `Evidence Store` and distiller abstractions.
- Keep current memory behavior working during transition.
- Align `skill-memory` with the shared evidence foundation.

### Phase 2

- Move `experience` and `fact` generation onto evidence-based distillation.
- Shift summary generation to be fully projection-driven.

### Phase 3

- Stop default registration of `append_experience_memory`, `write_fact_memory`, and related direct-write tools.
- Remove redundant category-specific read tools from the default Agent surface.
- Update docs and examples to reflect the new model:
  - `Task Memory` is written explicitly.
  - `Experience`, `Fact`, and `Skill` are distilled automatically.

## Open Questions

- What is the canonical schema for evidence records?
- What retention and compaction policy should govern evidence storage?
- How should fact conflict resolution be handled: automatic, assisted, or manual?
- Which parts of distillation should run synchronously versus asynchronously?
- Should there be a narrow manual correction surface for cases such as fact review or invalidation?
