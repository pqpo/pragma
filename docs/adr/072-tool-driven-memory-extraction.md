# ADR 072: Tool-driven Memory extraction

- Status: Accepted
- Date: 2026-10-15
- Extends: ADR 033, ADR 034, ADR 036

## Context

Memory Curator previously received an entire compact JSON projection and emitted a complete storage-shaped JSON object. A single message exceeding the byte budget disappeared from the prompt. Tools could not recover omitted evidence. Existing-fact selection checked subjects without checking recall bindings or expiry. The tool-assisted extraction setting did not preserve tool text through capture and projection.

## Decision

Episodic and Semantic Curator Missions use dedicated Host capabilities: evidence directory/read, related-memory lookup, candidate submission, and extraction completion. The Mission goal is short readable text. Small conversations without revocable tool content include their original text inline; other conversations expose paginated text. Tool content is never embedded in a persisted Mission goal; admission and capability resolution recheck its live authorization. Subject, evidence, property and existing-fact handles are scoped to a snapshot. Structured tool arguments are validated immediately; final assistant text is not a result protocol.

`@pragma/memory` owns versioned snapshots, candidate state, validation, receipts and materialization. `@pragma/built-in-agents` owns the DSL capability, prompts, tool descriptions and managed-tool adapter. Desktop supplies these through the existing Local Host Mission application and Execution MCP gateway. Native tools and arbitrary Context/file access are not permitted for the Curator. Knowledge/Skill revision routes remain independent.

A snapshot is identified by module, job id and input watermark. A new SQLite family at `state/memory/curator-sessions-v1.sqlite` has user version 1 and `pragma.memory-curator-session/v1` rows. Snapshot, candidate mutation and completion receipt are atomic single-database transactions under a cross-process file lock. There is no multi-file journal to coordinate. Future database or row versions fail closed; this new family has no historical migration source and does not rewrite existing Memory, job or archive formats. Subsequent schema upgrades require adjacent migrations and historical fixtures.

Completed receipts can settle an existing job without another model call, including expired-lease recovery. Claim and cancellation guards apply to tool operations and final materialization. An incomplete or unknown prior execution remains inspection-only on restart. Deleting source executions or failed jobs removes transient snapshots; normal maintenance uses the existing 30-day retention. Each snapshot and the session count have hard caps; capacity errors degrade the subsystem without deleting live work.

Initial task text is limited to 1,500 tokens; each evidence response to 2,000; evidence delivery to 32,000 per admission, with 64 tool calls. Runtime window inspection tightens the limit and reserves output space. All token estimation uses Core's RuntimeTokenCounter. Large text is read with stable character cursors. A read batches up to 20 adjacent passages within the same response budget and returns both the next evidence handle and character cursor, so short structural events do not each consume a model tool call. Completion requires full coverage of retained evidence; unread evidence and budget exhaustion cannot become a successful low-value rejection. Previously omitted capture content remains unavailable and is explicitly counted. Budget retries retain staged candidates and read coverage while resetting per-admission delivery counters. Explicit retries of other failed jobs discard the transient session before re-admission, so invalid receipts and changed authorization snapshots cannot be replayed forever. A changed evidence projection under the same watermark fails closed until that explicit retry.

Fact queries use the source task's binding, principal and expiry scope rather than the system Curator identity. Deduplication and replacement obey the same boundary. The model may reuse an existing property or declare an open predicate; existing predicates and historical fact values are not reinterpreted. Reusing a property handle rechecks the originating Fact permission, expiry and revision. Replacement carries the read revision internally and uses the existing CAS and direct-user-evidence checks. Conflicts are not linked across disjoint recall bindings.

Tool text is an additive `execution.tool.content` Evidence topic with schema `pragma.memory.tool-content/v1`. It records redacted available text, completeness and the modules authorized at capture admission. Existing v2 structural payloads retain their original meaning. Capture policy plus an enabled extraction setting admits text; current module settings further restrict reading. Complete and truncated PEM/OpenSSH private-key blocks and recognized standalone provider credentials are redacted before publication, including nested previews. Terminal Runtime diagnostics update the receipt with the actual response model when supplied and the execution completion time before materialization. The adapter never follows file paths or includes reasoning or provider diagnostics. Historic missing tool text is not backfilled. Original Evidence ids, visibility and provenance remain authoritative.

## Consequences

The model spends its context on source text and semantic decisions, while Host code manages identifiers, revisions, permissions and persistence. Formatting mistakes can be repaired during the same execution. Large inputs are inspectable rather than silently dropped; tasks that cannot finish within the budget require attention. Episode/Fact records, governance and immutable revision history keep their existing protocols.
