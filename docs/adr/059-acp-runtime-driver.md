# ADR 059: ACP Runtime Driver and Claude Code transport

## Status

Accepted

## Context

Claude Code's adapter owned a separate stream-json transport, event parser and native request lifecycle. ACP now provides a typed session protocol, while `claude-agent-acp` provides a Claude Agent SDK implementation with active-turn steering. Pragma needs to reuse its existing Runtime feature preparation, owner persistence and delivery semantics.

## Decision

Core exports `defineAcpRuntimeDriver()` alongside `defineRuntimeDriver()`. It owns the ACP stdio connection, subprocess supervision, initialization, session creation/loading, streaming normalization, provider-declared turn/session usage accounting and cancellation. Provider adapters supply the executable, session metadata, model selection, permission/elicitation callbacks and optional protocol extensions. Core depends on the vendor-neutral ACP SDK; it never imports a concrete agent.

`@pragma/runtime-claude-code` uses this driver with pinned `@agentclientprotocol/claude-agent-acp` 0.81.2 and ACP SDK 1.5.0. Pragma bundles an independent worker in CLI and Desktop builds. Users still install and authenticate the native Claude CLI; they do not install an ACP wrapper. The old stream-json execution implementation is removed.

Steering uses the advertised `_session/steering` extension and explicitly requests `idleBehavior: promptRequired`. Only `injected` confirms delivery to the existing turn. `promptRequired` is safely not dispatched and enters Core's existing prompt fallback. A timeout, disconnect or unexpected outcome is delivery-uncertain and must not be retried or turned into a detached prompt. Requests are serialized and bound to the active run ID, with an acknowledgement deadline below Core's two-second steer deadline.

ACP selected-option approvals cannot encode edited tool inputs. The bundled worker adds a namespaced `pragma.updatedInput` extension around the upstream public permission callback. Edits apply only after an offered `allow_once` decision succeeds and the request remains active. No upstream fork or alternate execution transport is retained.

## Persistence and isolation

The adapter retains its identity, native session ID, `claude-code-session-dir` format and Core ownership/checkpoint lifecycle. ACP loads Claude's existing native JSONL files within the same private `CLAUDE_CONFIG_DIR`. No persisted Schema or ownership protocol changes; no storage migration is necessary. The historical fixture was written by Claude 2.1.195 using the removed adapter's stream-json flags and is loaded in an opt-in executable test.

Pragma continues to project explicit system instructions, startup messages, managed Skills, permission settings, compaction hooks and its HTTP MCP gateway. `--bare`, empty setting sources and strict MCP configuration prevent ambient project/customization discovery. Runtime state and configuration remain outside the workspace.

Every fresh or restored Runtime session sends the latest assembled startup with its first successful prompt. Restore preserves native history and deliberately refreshes Context bodies rather than retaining the removed CLI's skip-on-resume behavior. This also recovers a compaction reinjection flag lost during process exit without a separate persistent delivery ledger. Ordinary later prompts do not repeat startup; completed compaction rearms injection as before.

## Verification

Real subprocess tests exercise Core factory integration, history replay, streaming, terminal tool deduplication, reported usage and Core token fallback, steering outcomes/races, cancellation, compaction and crashes. On macOS, Claude 2.1.195 with wrapper 0.81.2 completed the full provider-backed probe, including MCP, Skills, attachments, session refresh and injected steering. Both packaged CLI and Desktop workers also loaded the historical native fixture and recalled its marker. See [Claude ACP runtime](../architecture/claude-code-runtime.md) for commands and remaining coverage boundaries.
