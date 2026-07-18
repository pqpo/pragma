import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { McpToolRegistry, RuntimeAdapter, RuntimeCanUseResult } from "@pragma/core";
import {
  createMcpToolRegistry,
  defineRuntimeDriver,
  type ExpertAgentLogger,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";
import { CodexAppServerClient } from "./app-server-client.ts";
import { prepareManagedCodexHome } from "./codex-home.ts";
import {
  collectCodexUsage,
  consumeCodexStartupMessages,
  createCodexNativeSession,
  createCodexNotificationBus,
  listCodexMessages,
  mapCodexNotificationToRuntimeEvent,
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
  readonly mcpToolRegistry: McpToolRegistry;
  readonly expertToolsMcpRegistration: CodexExpertToolsMcpSessionRegistration;
}

export function createCodexRuntime(options: CodexRuntimeAdapterOptions = {}): RuntimeAdapter {
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
          checkpointOn: ["session.created", "turn.completed", "session.destroyed"],
          metadata: {
            format: "codex-managed-home",
          },
        };
      },
      async createSession(ctx): Promise<CodexDriverSession> {
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
        const codexHome = await prepareManagedCodexHome({
          agent: ctx.agent,
          sessionDir,
          env: ctx.processEnvironment,
          logger: ctx.logger,
        });
        if (state.threadId !== "") {
          const exists = await nativeSessionFileExists(join(codexHome, "sessions"), state.threadId);
          if (!exists) {
            throw new Error(`Codex runtime session file was not found: ${state.threadId}.`);
          }
        }
        let mcpToolRegistry: McpToolRegistry | undefined;
        let expertToolsMcpRegistration: CodexExpertToolsMcpSessionRegistration | undefined;
        let client: CodexAppServerClient | undefined;

        try {
          mcpToolRegistry = await createMcpToolRegistry(ctx.agent.mcp);
          expertToolsMcpRegistration = await registerCodexExpertToolsMcpSession({
            agent: ctx.agent,
            instanceId: ctx.systemSessionId,
            getContext: () => ctx.lifecycle.currentContext,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            logger: ctx.logger,
            mcpTools: mcpToolRegistry.tools,
            state: toolRuntimeState,
            executionContext: ctx.request.executionContext,
          });
          client = await CodexAppServerClient.start({
            executablePath,
            args: appendCodexExecutionMcpConfig(
              options.appServerArgs ?? ["app-server", "--listen", "stdio://"],
              expertToolsMcpRegistration,
            ),
            cwd: ctx.workspace,
            env: {
              ...ctx.processEnvironment,
              CODEX_HOME: codexHome,
            },
            clientInfo: options.clientInfo ?? DEFAULT_CODEX_CLIENT_INFO,
            spawn: options.spawn,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            onNotification: (notification) => {
              ctx.logger.debug("Codex app-server notification", {
                method: notification.method,
                params: notification.params,
              });
              notificationBus.publish(notification);
            },
            onStderr: (chunk) => {
              ctx.logger.debug("Codex app-server stderr", { chunk });
            },
          });
          const threadStartResult = await startOrResumeThread({
            client,
            runtimeSessionId: state.threadId,
            cwd: ctx.workspace,
            model: defaultModelName,
            thinkingLevel: defaultThinkingLevel,
            developerInstructions: ctx.agentContext.systemPrompt,
            sandboxMode: options.sandboxMode,
            approvalPolicy: options.approvalPolicy,
          });
          state.threadId = threadStartResult.threadId;

          return {
            ...createCodexNativeSession({
              client,
              notificationBus,
              state,
              defaultModelName,
              defaultThinkingLevel,
              codexHome,
              startupMessages: threadStartResult.startedFreshThread
                ? ctx.agentContext.startupMessages
                : [],
            }),
            mcpToolRegistry,
            expertToolsMcpRegistration,
          };
        } catch (error) {
          try {
            await disposeCodexRuntimeResources(
              client,
              expertToolsMcpRegistration,
              mcpToolRegistry,
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
        assertRuntimeManagedProvider(turn.modelSelection?.model.providerId, "openai", "Codex");
        const modelName = turn.modelSelection?.model.modelId ?? session.defaultModelName;
        const thinkingLevel = turn.modelSelection?.thinkingLevel ?? session.defaultThinkingLevel;
        if (modelName !== undefined || thinkingLevel !== undefined) {
          assertCodexModelSelection(await listModels(), modelName, thinkingLevel);
        }
        return await startCodexTurn(session, {
          ...turn,
          modelSelection:
            modelName === undefined
              ? undefined
              : { model: { providerId: "openai", modelId: modelName }, thinkingLevel },
        });
      },
      mapEvent: mapCodexNotificationToRuntimeEvent,
      async collectUsage(session, ctx) {
        return await collectCodexUsage(session, ctx.startedAt, ctx.usage);
      },
      async cancelTurn(session) {
        if (session.state.threadId !== "") {
          await session.client.interruptTurn(session.state.threadId).catch(() => undefined);
        }
      },
      async closeSession(session, ctx) {
        await disposeCodexRuntimeResources(
          session.client,
          session.expertToolsMcpRegistration,
          session.mcpToolRegistry,
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
  mcpToolRegistry: McpToolRegistry | undefined,
  logger: ExpertAgentLogger,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => client?.close()),
    expertToolsMcpRegistration?.dispose() ?? Promise.resolve(),
    mcpToolRegistry?.dispose() ?? Promise.resolve(),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );

  if (errors.length === 0) {
    return;
  }

  logger.error("Codex runtime cleanup failed", { errors });

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
