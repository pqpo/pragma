# OpenCode Runtime

`@pragma/runtime-opencode` is a local Runtime Adapter assembled by Desktop and CLI. It supports the OpenCode CLI's 1.x and 2.x major versions through their corresponding TypeScript clients. Each Pragma Runtime Session starts a loopback OpenCode `serve` process with a random HTTP Basic Auth password. The process is closed with the Pragma session; the OpenCode session ID is checkpointed so a later process can restore the conversation.

## Protocol choice

OpenCode supports ACP in both [1.x](https://opencode.ai/docs/acp) and [2.x](https://opencode.ai/v2/docs/cli/acp/). `opencode acp` communicates over stdio JSON-RPC and is intended for editor clients. Pragma uses the versioned SDK clients instead: `@opencode-ai/sdk` for 1.x and `@opencode/client` for 2.x. They expose the native HTTP session, event, model, MCP, permission, and compaction APIs needed by the Runtime Adapter. The server stays on `127.0.0.1`; it is not a Desktop cloud bridge endpoint.

## Configuration and storage

The adapter runs the user's installed `opencode` executable and reads the same OpenCode config and native authentication as a local CLI invocation. This includes CC Switch configurations in OpenCode's standard config and auth locations. Each Runtime Session overrides `XDG_DATA_HOME` with a private directory inside Pragma's owned Runtime Session; its native `auth.json` is linked from the host, or copied with restricted permissions when links are unavailable. `OPENCODE_CONFIG_CONTENT`, when supplied to the Desktop or CLI host process, is forwarded only to this adapter. The adapter does not copy credentials into the Pragma workspace.

Pragma's MCP gateway is registered only for the private process. On 1.x it is injected through `OPENCODE_CONFIG_CONTENT` because the 1.x MCP add API writes a project config file. On 2.x the MCP add API was verified against a temporary project and did not write a project or user config file. Runtime session metadata and OpenCode's native conversation data live under Pragma's owned `state/runtime-sessions` directory and follow the same owner deletion lifecycle. Native OpenCode sessions are restored by ID only within that private data home and the original workspace.

## Current feature boundary

The adapter handles model discovery and selection, system prompts, resumed sessions, text/reasoning/tool events, human permission decisions, MCP tools, attachments, usage accounting, cancellation, and manual compaction. Reported OpenCode usage takes precedence; the shared Core token counter estimates usage only when OpenCode omits it. Directory attachments are supplied as paths in prompt text. Pragma Skill materialization, active-turn steering, and context-window inspection are not wired to a stable cross-version API and are reported as unsupported.

Both major versions have an isolated executable smoke test for server startup, session creation/restoration, model listing, and MCP config isolation. A second test connects the real CLI to a local OpenAI-compatible mock model and verifies a completed prompt with a text delta. The tests are enabled with `PRAGMA_OPENCODE_V1_PATH` and `PRAGMA_OPENCODE_V2_PATH` while running `pnpm --filter @pragma/runtime-opencode test`. They do not use a real provider credential.

## Feature acceptance record

The following statuses use the [Runtime integration checklist](../conventions/runtime-adapter-integration-checklist.md). All implementation paths are in `packages/runtime/opencode/src/`; the executable smoke is `test/process.integration.test.ts`. The smoke used OpenCode 1.18.32 and 2.0.16 on macOS on 2026-09-24 with temporary, unauthenticated homes. `Degraded` means the code path exists but the required provider-backed behavior has not been proven. The model turn used a local simulated provider; it did not execute an MCP tool.

| Feature                                 | Status and evidence boundary                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| availability                            | Degraded: CLI/version and server readiness exercised; no authenticated provider.                            |
| authentication                          | Degraded: host config/auth paths passed through; no authenticated smoke.                                    |
| modelDiscovery                          | Degraded: SDK catalog requests exercised; custom models can run even when the catalog is empty.             |
| modelSelection, thinking                | Degraded: SDK selector/variant wired; no provider-backed turn.                                              |
| freshSession, resume                    | Degraded: both native APIs exercised; no resumed prompt.                                                    |
| systemPrompt, startupMessages           | Degraded: SDK instructions/turn body wired; no behavioral assertion for system or startup instructions.     |
| textStreaming                           | Degraded: real 1.x/2.x CLIs produced text deltas before the final response using a simulated provider.      |
| reasoningStreaming, nativeToolLifecycle | Degraded: public event types mapped; no live reasoning/tool fixture.                                        |
| mcp                                     | Degraded: registration and config isolation exercised; tool discovery and call unverified.                  |
| permissions, userInteraction            | Degraded: native permission reply and Host callback wired; no live approval turn.                           |
| skills                                  | Unsupported: Pragma Skill materialization is not wired.                                                     |
| attachmentImage, attachmentFile         | Degraded: file URI attachment is wired; no model turn.                                                      |
| attachmentDirectory                     | Degraded: directory path is added to prompt text.                                                           |
| usage                                   | Degraded: native token counts and Core fallback wired; simulated provider reported zero tokens.             |
| contextWindow                           | Unsupported: no consistent cross-version inspection API is wired.                                           |
| compaction                              | Degraded: native APIs wired; no live compaction smoke.                                                      |
| cancellation                            | Degraded: native APIs wired; no active-turn smoke.                                                          |
| steering                                | Unsupported: no common cross-version active-turn API is wired.                                              |
| close, cleanup                          | Degraded: private server/process-group cleanup and owned data home exercised; owner deletion not exercised. |
