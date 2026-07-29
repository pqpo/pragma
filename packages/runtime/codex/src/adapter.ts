import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  McpToolRegistry,
  McpToolRegistryLease,
  RuntimeAdapter,
  RuntimeCanUseResult,
} from "@pragma/core";
import {
  createMcpToolRegistryPool,
  defineRuntimeDriver,
  type PragmaLogger,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";
import { CodexAppServerClient } from "./app-server-client.ts";
import { prepareManagedCodexHome } from "./codex-home.ts";
import {
  collectCodexUsage,
  compactCodexContextWindow,
  consumeCodexStartupMessages,
  createCodexNativeSession,
  createCodexNotificationBus,
  listCodexMessages,
  mapCodexNotificationToRuntimeEvent,
  readCodexContextWindow,
  startCodexTurn,
  type CodexNativeSession,
  type CodexRuntimeSessionState,
} from "./session.ts";
import type { CodexRuntimeAdapterOptions } from "./types.ts";
import { assertCodexModelSelection, createCodexModelDiscovery } from "./models.ts";
import { canUseCodexRuntime } from "./availability.ts";
import { resolveCodexExecutablePath } from "./executable.ts";
import { appendCodexExecutionMcpConfig } from "./execution-mcp-config.ts";
import {
  type CodexExpertToolRuntimeState,
  type CodexExpertToolsMcpSessionRegistration,
  registerCodexExpertToolsMcpSession,
} from "./expert-tools-mcp-server.ts";

const CODEX_LOCAL_RUNTIME_DESCRIPTOR = {
  id: "codex-local",
  kind: "codex-local" as const,
  displayName: "Codex Local",
  capabilities: {
    targets: ["agent"],
    executionLocations: ["local"],
    supportsAbort: true,
    supportsMcp: true,
    supportsModelDiscovery: true,
    supportsStreaming: true,
    supportsThinkingLevel: true,
  },
};

const DEFAULT_CODEX_CLIENT_INFO = {
  name: "pragma_codex_runtime",
  title: "Pragma Codex Runtime",
  version: "0.1.0",
};

interface CodexDriverSession extends CodexNativeSession {
  readonly logger: PragmaLogger;
  readonly mcpToolRegistry: McpToolRegistry;
  readonly mcpToolRegistryLease: McpToolRegistryLease;
  readonly expertToolsMcpRegistration: CodexExpertToolsMcpSessionRegistration;
}

export function createCodexRuntime(options: CodexRuntimeAdapterOptions = {}): RuntimeAdapter {
  const mcpToolRegistries = createMcpToolRegistryPool();
  const executablePath =
    options.executablePath ??
    (options.spawn === undefined ? resolveCodexExecutablePath(options) : "codex");
  const descriptor = {
    ...CODEX_LOCAL_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CODEX_LOCAL_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CODEX_LOCAL_RUNTIME_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };
  const listModels = options.listModels ?? createCodexModelDiscovery(options);

  return defineRuntimeDriver(
    {
      descriptor,
      canUse: createCodexRuntimeCanUse(options),
      listModels,
      outputRetryLimit: options.outputRetryLimit,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: ctx.paths.runtimeSessionDir("codex"),
          checkpointOn: [
            "session.created",
            "turn.completed",
            "context.compacted",
            "session.destroyed",
          ],
          metadata: {
            format: "codex-managed-home",
          },
        };
      },
      async createSession(ctx): Promise<CodexDriverSession> {
        const sessionStartedAt = performance.now();
        assertRuntimeManagedProvider(
          ctx.request.modelSelection?.model.providerId,
          "openai",
          "Codex",
        );
        const defaultModelName =
          ctx.request.modelSelection?.model.modelId ?? options.defaultModelName;
        const defaultThinkingLevel =
          ctx.request.modelSelection?.thinkingLevel ?? options.defaultThinkingLevel;
        if (defaultModelName !== undefined || defaultThinkingLevel !== undefined) {
          assertCodexModelSelection(await listModels(), defaultModelName, defaultThinkingLevel);
        }
        const notificationBus = createCodexNotificationBus();
        const toolRuntimeState: CodexExpertToolRuntimeState = {};
        const state: CodexRuntimeSessionState = {
          threadId:
            ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "",
        };
        const sessionDir = ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("codex");
        const codexHomePromise = timedCodexPhase(
          ctx.logger,
          "managed_home",
          sessionStartedAt,
          async () =>
            await prepareManagedCodexHome({
              agent: ctx.agent,
              sessionDir,
              pragmaPaths: ctx.paths.pragma,
              env: ctx.processEnvironment,
              logger: ctx.logger,
            }),
        );
        const registryLeasePromise = timedCodexPhase(
          ctx.logger,
          "mcp_tool_registry",
          sessionStartedAt,
          async () => await mcpToolRegistries.acquire(ctx.agent.mcp),
        );
        let mcpToolRegistry: McpToolRegistry | undefined;
        let mcpToolRegistryLease: McpToolRegistryLease | undefined;
        let expertToolsMcpRegistration: CodexExpertToolsMcpSessionRegistration | undefined;
        let client: CodexAppServerClient | undefined;

        try {
          const [codex, registryLease] = await Promise.all([
            codexHomePromise,
            registryLeasePromise,
          ]);
          mcpToolRegistryLease = registryLease;
          mcpToolRegistry = registryLease.registry;
          const [restoreExists, registration] = await Promise.all([
            state.threadId === ""
              ? Promise.resolve(true)
              : timedCodexPhase(
                  ctx.logger,
                  "restore_session_lookup",
                  sessionStartedAt,
                  async () =>
                    await nativeSessionFileExists(join(codex.home, "sessions"), state.threadId),
                ),
            timedCodexPhase(ctx.logger, "mcp_tool_registration", sessionStartedAt, async () =>
              registerCodexExpertToolsMcpSession({
                agent: ctx.agent,
                getContext: () => ctx.lifecycle.currentContext,
                humanInteractionHandler: ctx.request.humanInteractionHandler,
                logger: ctx.logger,
                mcpTools: mcpToolRegistry!.tools,
                state: toolRuntimeState,
                executionContext: ctx.request.executionContext,
              }),
            ),
          ]);
          if (!restoreExists) {
            await registration.dispose();
            throw new Error(`Codex runtime session file was not found: ${state.threadId}.`);
          }
          expertToolsMcpRegistration = registration;
          ctx.logger.info(
            "runtime.codex_process_spawn_requested",
            "Codex app-server native process spawn requested",
            { elapsedMs: codexElapsedMs(sessionStartedAt), executablePath },
          );
          const processStartedAt = performance.now();
          client = await CodexAppServerClient.start({
            executablePath,
            args: appendCodexExecutionMcpConfig(
              options.appServerArgs ?? ["app-server", "--listen", "stdio://"],
              expertToolsMcpRegistration,
            ),
            cwd: ctx.workspace,
            env: {
              ...ctx.processEnvironment,
              CODEX_HOME: codex.home,
              CODEX_SQLITE_HOME: codex.sqliteHome,
            },
            clientInfo: options.clientInfo ?? DEFAULT_CODEX_CLIENT_INFO,
            spawn: options.spawn,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            onNotification: (notification) => {
              ctx.logger.debug("runtime.codex_notification", "Codex app-server notification", {
                method: notification.method,
                params: notification.params,
              });
              notificationBus.publish(notification);
            },
            onStderr: (chunk) => {
              ctx.logger.debug("runtime.codex_stderr", "Codex app-server stderr", { chunk });
            },
          });
          ctx.logger.info("runtime.codex_initialized", "Codex app-server initialized", {
            durationMs: codexElapsedMs(processStartedAt),
            elapsedMs: codexElapsedMs(sessionStartedAt),
          });
          const threadStartResult = await timedCodexPhase(
            ctx.logger,
            state.threadId === "" ? "thread_start" : "thread_resume",
            sessionStartedAt,
            async () =>
              await startOrResumeThread({
                client: client!,
                runtimeSessionId: state.threadId,
                cwd: ctx.workspace,
                model: defaultModelName,
                thinkingLevel: defaultThinkingLevel,
                developerInstructions: ctx.agentContext.systemPrompt,
                sandboxMode: options.sandboxMode,
                approvalPolicy: options.approvalPolicy,
              }),
          );
          state.threadId = threadStartResult.threadId;
          ctx.logger.info("runtime.codex_session_ready", "Codex Session preparation completed", {
            elapsedMs: codexElapsedMs(sessionStartedAt),
            systemPromptCharacters: ctx.agentContext.systemPrompt.length,
            toolCount: mcpToolRegistry.tools.length,
          });

          return {
            ...createCodexNativeSession({
              client,
              notificationBus,
              state,
              defaultModelName,
              defaultThinkingLevel,
              codexHome: codex.home,
              startupMessages: threadStartResult.startedFreshThread
                ? ctx.agentContext.startupMessages
                : [],
            }),
            logger: ctx.logger,
            mcpToolRegistry,
            mcpToolRegistryLease,
            expertToolsMcpRegistration,
          };
        } catch (error) {
          if (mcpToolRegistryLease === undefined) {
            const registry = await Promise.allSettled([registryLeasePromise]);
            if (registry[0]?.status === "fulfilled") {
              mcpToolRegistryLease = registry[0].value;
              mcpToolRegistry = registry[0].value.registry;
            }
          }
          try {
            await disposeCodexRuntimeResources(
              client,
              expertToolsMcpRegistration,
              mcpToolRegistryLease,
              ctx.logger,
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Codex runtime initialization and cleanup failed.",
              { cause: cleanupError },
            );
          }
          throw error;
        }
      },
      readSession(session) {
        return {
          runtimeSessionId: session.state.threadId,
        };
      },
      listMessages: listCodexMessages,
      consumeStartupMessages: consumeCodexStartupMessages,
      async startTurn(session, turn) {
        const requestStartedAt = performance.now();
        assertRuntimeManagedProvider(turn.modelSelection?.model.providerId, "openai", "Codex");
        const modelName = turn.modelSelection?.model.modelId ?? session.defaultModelName;
        const thinkingLevel = turn.modelSelection?.thinkingLevel ?? session.defaultThinkingLevel;
        if (modelName !== undefined || thinkingLevel !== undefined) {
          assertCodexModelSelection(await listModels(), modelName, thinkingLevel);
        }
        return await startCodexTurn(
          session,
          {
            ...turn,
            modelSelection:
              modelName === undefined
                ? undefined
                : { model: { providerId: "openai", modelId: modelName }, thinkingLevel },
          },
          () => {
            session.logger.info(
              "runtime.codex_request_acknowledged",
              "Codex acknowledged the native turn request",
              {
                runId: turn.runId,
                elapsedMs: codexElapsedMs(requestStartedAt),
              },
            );
          },
        );
      },
      mapEvent: mapCodexNotificationToRuntimeEvent,
      async collectUsage(session, ctx) {
        return await collectCodexUsage(session, ctx.startedAt, ctx.usage);
      },
      readContextWindow: readCodexContextWindow,
      compactContext: compactCodexContextWindow,
      async cancelTurn(session) {
        if (session.state.threadId !== "") {
          await session.client.interruptTurn(session.state.threadId).catch(() => undefined);
        }
      },
      async closeSession(session, ctx) {
        await disposeCodexRuntimeResources(
          session.client,
          session.expertToolsMcpRegistration,
          session.mcpToolRegistryLease,
          ctx.logger,
        );
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
      createProcessEnvironment: () => ({ ...process.env, ...(options.env ?? {}) }),
    },
  );
}

async function timedCodexPhase<T>(
  logger: Pick<PragmaLogger, "info">,
  phase: string,
  sessionStartedAt: number,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const value = await operation();
  logger.info("runtime.codex_prepare_phase", `Codex preparation phase completed: ${phase}`, {
    phase,
    durationMs: codexElapsedMs(startedAt),
    elapsedMs: codexElapsedMs(sessionStartedAt),
  });
  return value;
}

function codexElapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

function assertRuntimeManagedProvider(
  providerId: string | undefined,
  expectedProviderId: string,
  runtime: string,
): void {
  if (providerId !== undefined && providerId !== expectedProviderId) {
    throw new Error(`${runtime} runtime only supports provider ${expectedProviderId}.`);
  }
}

async function nativeSessionFileExists(root: string, runtimeSessionId: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await nativeSessionFileExists(path, runtimeSessionId)) {
        return true;
      }
    } else if (
      entry.isFile() &&
      entry.name.endsWith(".jsonl") &&
      entry.name.endsWith(`${runtimeSessionId}.jsonl`)
    ) {
      return true;
    }
  }
  return false;
}

function createCodexRuntimeCanUse(
  options: CodexRuntimeAdapterOptions,
): () => Promise<RuntimeCanUseResult> | RuntimeCanUseResult {
  if (options.canUse !== undefined) {
    return options.canUse;
  }

  if (options.spawn !== undefined) {
    return () => ({
      usable: true,
      details: {
        probe: "skipped",
        reason: "Custom Codex spawn was provided.",
      },
    });
  }

  return async () =>
    await canUseCodexRuntime({
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
}

async function disposeCodexRuntimeResources(
  client: CodexAppServerClient | undefined,
  expertToolsMcpRegistration: CodexExpertToolsMcpSessionRegistration | undefined,
  mcpToolRegistryLease: McpToolRegistryLease | undefined,
  logger: PragmaLogger,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => client?.close()),
    expertToolsMcpRegistration?.dispose() ?? Promise.resolve(),
    mcpToolRegistryLease?.release() ?? Promise.resolve(),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );

  if (errors.length === 0) {
    return;
  }

  logger.error(
    "runtime.codex_cleanup_failed",
    "Codex runtime cleanup failed",
    new AggregateError(errors),
  );

  if (errors.length === 1) {
    throw errors[0];
  }

  throw new AggregateError(errors, "Codex runtime session cleanup failed.");
}

async function startOrResumeThread({
  client,
  runtimeSessionId,
  cwd,
  model,
  thinkingLevel,
  developerInstructions,
  sandboxMode,
  approvalPolicy,
}: {
  readonly client: CodexAppServerClient;
  readonly runtimeSessionId: string;
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly thinkingLevel?: string | undefined;
  readonly developerInstructions?: string | undefined;
  readonly sandboxMode?: string | undefined;
  readonly approvalPolicy?: string | undefined;
}): Promise<{
  readonly threadId: string;
  readonly startedFreshThread: boolean;
}> {
  if (runtimeSessionId !== "") {
    const threadId = await client.resumeThread(runtimeSessionId, {
      cwd,
      model,
      thinkingLevel,
      developerInstructions,
    });
    return {
      threadId,
      startedFreshThread: false,
    };
  }

  const threadId = await client.startThread({
    cwd,
    model,
    thinkingLevel,
    developerInstructions,
    sandboxMode,
    approvalPolicy,
  });
  return {
    threadId,
    startedFreshThread: true,
  };
}
