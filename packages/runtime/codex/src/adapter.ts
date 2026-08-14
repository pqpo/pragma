import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeAdapter, RuntimeCanUseResult } from "@pragma/core";
import {
  createExpertToolsHttpMcpFeature,
  createMcpToolRegistryPool,
  defineRuntimeFeatures,
  defineRuntimeDriver,
  runtimeFeature,
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
  steerCodexTurn,
  type CodexNativeSession,
  type CodexRuntimeSessionState,
} from "./session.ts";
import type { CodexRuntimeAdapterOptions } from "./types.ts";
import { assertCodexModelSelection, createCodexModelDiscovery } from "./models.ts";
import { canUseCodexRuntime } from "./availability.ts";
import { resolveCodexExecutablePath } from "./executable.ts";
import { appendCodexExecutionMcpConfig } from "./execution-mcp-config.ts";

const CODEX_LOCAL_RUNTIME_DESCRIPTOR = {
  id: "codex-local",
  kind: "codex-local" as const,
  displayName: "Codex Local",
  capabilities: {
    targets: ["agent"],
    executionLocations: ["local"],
  },
};

const CODEX_EVIDENCE_PENDING =
  "Implemented in the adapter; an executed Runtime probe evidence bundle is not recorded yet.";

const DEFAULT_CODEX_CLIENT_INFO = {
  name: "pragma_codex_runtime",
  title: "Pragma Codex Runtime",
  version: "0.1.0",
};

interface CodexDriverSession extends CodexNativeSession {
  readonly logger: PragmaLogger;
}

export function createCodexRuntime(options: CodexRuntimeAdapterOptions = {}): RuntimeAdapter {
  const mcpToolRegistries = options.mcpToolRegistryPool ?? createMcpToolRegistryPool();
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
  const implemented = () => runtimeFeature.native(runtimeFeature.degraded(CODEX_EVIDENCE_PENDING));
  const mcp = createExpertToolsHttpMcpFeature({
    readiness: runtimeFeature.degraded(CODEX_EVIDENCE_PENDING),
    pool: mcpToolRegistries,
    resourcePrefix: "codex",
  });
  const skills = runtimeFeature.session({
    id: "codex.managed-home",
    readiness: runtimeFeature.degraded(CODEX_EVIDENCE_PENDING),
    async prepare(ctx) {
      const sessionDir = ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("codex");
      return await prepareManagedCodexHome({
        agent: ctx.agent,
        sessionDir,
        pragmaPaths: ctx.paths.pragma,
        env: ctx.processEnvironment,
        logger: ctx.logger,
      });
    },
  });
  const permissions = runtimeFeature.session({
    id: "codex.permissions",
    readiness: runtimeFeature.degraded(CODEX_EVIDENCE_PENDING),
    prepare(ctx) {
      return {
        sandboxMode: options.sandboxMode,
        approvalPolicy: options.approvalPolicy,
        humanInteractionHandler: ctx.request.humanInteractionHandler,
      };
    },
  });
  const features = defineRuntimeFeatures({
    availability: implemented(),
    authentication: implemented(),
    modelDiscovery: implemented(),
    modelSelection: implemented(),
    thinking: implemented(),
    freshSession: implemented(),
    resume: implemented(),
    systemPrompt: implemented(),
    startupMessages: implemented(),
    textStreaming: implemented(),
    reasoningStreaming: implemented(),
    nativeToolLifecycle: implemented(),
    mcp,
    permissions,
    userInteraction: implemented(),
    skills,
    attachmentImage: implemented(),
    attachmentFile: implemented(),
    attachmentDirectory: implemented(),
    usage: implemented(),
    contextWindow: implemented(),
    compaction: runtimeFeature.native(
      runtimeFeature.degraded(CODEX_EVIDENCE_PENDING, { compactionModes: ["manual", "events"] }),
    ),
    cancellation: implemented(),
    steering: implemented(),
    close: implemented(),
    cleanup: implemented(),
  });

  return defineRuntimeDriver(
    {
      descriptor,
      features,
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
        const state: CodexRuntimeSessionState = {
          threadId:
            ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "",
        };
        const codex = ctx.features.skills;
        const mcp = ctx.features.mcp;
        const permissions = ctx.features.permissions;
        let client: CodexAppServerClient | undefined;

        try {
          const [restoreExists] = await Promise.all([
            state.threadId === ""
              ? Promise.resolve(true)
              : timedCodexPhase(
                  ctx.logger,
                  "restore_session_lookup",
                  sessionStartedAt,
                  async () =>
                    await nativeSessionFileExists(join(codex.home, "sessions"), state.threadId),
                ),
          ]);
          if (!restoreExists) {
            throw new Error(`Codex runtime session file was not found: ${state.threadId}.`);
          }
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
              mcp.registration,
            ),
            cwd: ctx.workspace,
            env: {
              ...ctx.processEnvironment,
              CODEX_HOME: codex.home,
              CODEX_SQLITE_HOME: codex.sqliteHome,
            },
            clientInfo: options.clientInfo ?? DEFAULT_CODEX_CLIENT_INFO,
            spawn: options.spawn,
            humanInteractionHandler: permissions.humanInteractionHandler,
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
                sandboxMode: permissions.sandboxMode,
                approvalPolicy: permissions.approvalPolicy,
              }),
          );
          state.threadId = threadStartResult.threadId;
          ctx.logger.info("runtime.codex_session_ready", "Codex Session preparation completed", {
            elapsedMs: codexElapsedMs(sessionStartedAt),
            systemPromptCharacters: ctx.agentContext.systemPrompt.length,
            toolCount: mcp.registry.tools.length,
            mcpOpenedConnections: mcp.lease.stats.openedConnections,
            mcpReusedConnections: mcp.lease.stats.reusedConnections,
            mcpCoalescedConnections: mcp.lease.stats.coalescedConnections,
          });

          return {
            ...createCodexNativeSession({
              client,
              notificationBus,
              state,
              defaultModelName,
              defaultThinkingLevel,
              codexHome: codex.home,
              tokenCounter: options.tokenCounter,
              startupMessages: threadStartResult.startedFreshThread
                ? ctx.agentContext.startupMessages
                : [],
            }),
            logger: ctx.logger,
          };
        } catch (error) {
          try {
            await client?.close();
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
      steerTurn: steerCodexTurn,
      readContextWindow: readCodexContextWindow,
      compactContext: compactCodexContextWindow,
      async cancelTurn(session) {
        if (session.state.threadId !== "") {
          await session.client.interruptTurn(session.state.threadId).catch(() => undefined);
        }
      },
      async closeSession(session) {
        await session.client.close();
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
      createProcessEnvironment: () => ({ ...(options.env ?? process.env) }),
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
