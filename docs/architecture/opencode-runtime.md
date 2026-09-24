# OpenCode Runtime

`@pragma/runtime-opencode` is a local Runtime Adapter assembled by Desktop and CLI. It supports OpenCode CLI 1.18.32+ and 2.0.16+ through their corresponding TypeScript clients. Each Pragma Runtime Session starts a loopback OpenCode `serve` process with a random HTTP Basic Auth password. The process is closed with the Pragma session; the OpenCode session ID is checkpointed so a later process can restore the conversation.

## Protocol choice

OpenCode supports ACP in both [1.x](https://opencode.ai/docs/acp) and [2.x](https://opencode.ai/v2/docs/cli/acp/). `opencode acp` communicates over stdio JSON-RPC and is intended for editor clients. Pragma uses the versioned SDK clients instead: `@opencode-ai/sdk` for 1.x and `@opencode/client` for 2.x. They expose the native HTTP session, event, model, MCP, permission, and compaction APIs needed by the Runtime Adapter. The server stays on `127.0.0.1`; it is not a Desktop cloud bridge endpoint.

## Configuration and storage

The adapter runs the user's installed `opencode` executable. It imports provider implementation and model settings from trusted host global, explicit, and inline OpenCode configuration. Project and ancestor `opencode.json` files contribute only plain model and provider selectors plus explicit permission denials; their `provider` and `providers` implementations are excluded because OpenCode can load provider packages and resolve file or environment substitutions from them. MCP servers, plugins, custom tools, agents, commands, hooks, and other executable customization are not imported. It starts the CLI with a private config directory, disables project config discovery and external plugins, and refuses a workspace whose ancestor has a `.opencode` customization directory. This last check is required because OpenCode 1.18.x can still load project plugin files with its disable flags set. Explicit permission denials remain in the managed policy. A workspace that relies on `.opencode` customization must remove or relocate it before using this Runtime.

Each Runtime Session overrides `XDG_DATA_HOME` with a private directory inside Pragma's owned Runtime Session; its native `auth.json` is linked from the host, or copied with restricted permissions when links are unavailable. This retains native CLI login, including CC Switch auth in the standard location, without placing credentials in the Pragma workspace. Provider keys in model configuration remain available to the OpenCode server.

Pragma's MCP gateway is registered only for the private process. On 1.x it is injected through `OPENCODE_CONFIG_CONTENT` because the 1.x MCP add API writes a project config file. On 2.x the MCP add API was verified against a temporary project and did not write a project or user config file. Runtime session metadata and OpenCode's native conversation data live under Pragma's owned `state/runtime-sessions` directory and follow the same owner deletion lifecycle. Native OpenCode sessions are restored by ID only within that private data home and the original workspace.

## Permission boundary

In `request-approval`, workspace edits and network requests ask the Host; workspace reads are allowed. In `auto-approve`, workspace file operations are allowed. Both modes deny external directories and native shell/Code Mode execution. A shell spawned by OpenCode inherits the server's loopback password and possibly model credentials, so allowing one command would grant access to the native control API. `full-access` alone permits native shell execution. These restrictions use each version's permission dialect; 2.x also receives hard denial policies for shell, Code Mode, and external directories. Unknown approval requests are denied in `auto-approve`.

## Current feature boundary

The adapter handles model discovery and selection, system prompts, resumed sessions, text/reasoning/tool events, human permission decisions, OpenCode 1.x questions and 2.x forms, Pragma MCP tools, attachments, usage accounting, cancellation, and manual compaction. Reported OpenCode usage takes precedence; the shared Core token counter estimates usage when OpenCode omits it or reports an all-zero snapshot for nonempty output. The estimate serializes the system prompt, prior native context, current prompt, and attachment metadata. Directory attachments are supplied as paths in prompt text. Pragma Skill materialization, active-turn steering, and context-window inspection are not wired to a stable cross-version API and are reported as unsupported.

Both major versions have an isolated executable smoke test for server startup, session creation/restoration, model listing, and MCP config isolation. A second test connects the real CLI to a local OpenAI-compatible mock model and verifies a completed prompt with a text delta. The tests are enabled with `PRAGMA_OPENCODE_V1_PATH` and `PRAGMA_OPENCODE_V2_PATH` while running `pnpm --filter @pragma/runtime-opencode test`. They do not use a real provider credential.

## Feature acceptance record

The following statuses use the [Runtime integration checklist](../conventions/runtime-adapter-integration-checklist.md). All implementation paths are in `packages/runtime/opencode/src/`; the executable smoke is `test/process.integration.test.ts`. The smoke used OpenCode 1.18.32 and 2.0.16 on macOS on 2026-09-24 with temporary, unauthenticated homes. `Degraded` means the code path exists but the required provider-backed behavior has not been proven. The model turn used a local simulated provider; it did not execute an MCP tool.

| Feature                                 | Status and evidence boundary                                                                                |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| availability                            | Degraded: version floor and server readiness exercised; no authenticated provider.                          |
| authentication                          | Degraded: host auth reused and model settings imported into a private home; no authenticated smoke.         |
| modelDiscovery                          | Degraded: SDK catalog requests exercised; custom models can run even when the catalog is empty.             |
| modelSelection, thinking                | Degraded: SDK selector/variant wired; no provider-backed turn.                                              |
| freshSession, resume                    | Degraded: both native APIs exercised; no resumed prompt.                                                    |
| systemPrompt, startupMessages           | Degraded: SDK instructions/turn body wired; no behavioral assertion for system or startup instructions.     |
| textStreaming                           | Degraded: real 1.x/2.x CLIs produced text deltas before the final response using a simulated provider.      |
| reasoningStreaming, nativeToolLifecycle | Degraded: public event types mapped; no live reasoning/tool fixture.                                        |
| mcp                                     | Degraded: Pragma-only registration and config isolation exercised; tool discovery and call unverified.      |
| permissions, userInteraction            | Degraded: restricted policies and 1.x question/2.x form callbacks wired; no live approval/question turn.    |
| skills                                  | Unsupported: Pragma Skill materialization is not wired.                                                     |
| attachmentImage, attachmentFile         | Degraded: file URI attachment is wired; no model turn.                                                      |
| attachmentDirectory                     | Degraded: directory path is added to prompt text.                                                           |
| usage                                   | Degraded: native counts and Core fallback wired; all-zero snapshots trigger context-inclusive estimation.   |
| contextWindow                           | Unsupported: no consistent cross-version inspection API is wired.                                           |
| compaction                              | Degraded: native APIs wired; no live compaction smoke.                                                      |
| cancellation                            | Degraded: native APIs wired; no active-turn smoke.                                                          |
| steering                                | Unsupported: no common cross-version active-turn API is wired.                                              |
| close, cleanup                          | Degraded: private server/process-group cleanup and owned data home exercised; owner deletion not exercised. |
