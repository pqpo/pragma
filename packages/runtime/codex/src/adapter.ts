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
import {
  assertCodexModelSelection,
  assertCodexProviderConfig,
  createCodexModelDiscovery,
} from "./models.ts";
import { canUseCodexRuntime } from "./availability.ts";
import { resolveCodexExecutablePath } from "./executable.ts";
import {
  createCodexWorkflowToolsMcpServer,
  type CodexWorkflowToolsMcpServer,
  type CodexWorkflowToolRuntimeState,
} from "./workflow-tools-mcp-server.ts";

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
  readonly workflowToolsMcpServer: CodexWorkflowToolsMcpServer;
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
        assertCodexProviderConfig(ctx.request);
        const defaultModelName = options.defaultModelName ?? ctx.agent.models?.defaultModelName;
        if (defaultModelName !== undefined || options.defaultThinkingLevel !== undefined) {
          assertCodexModelSelection(
            await listModels(),
            defaultModelName,
            options.defaultThinkingLevel,
          );
        }
        const notificationBus = createCodexNotificationBus();
        const toolRuntimeState: CodexWorkflowToolRuntimeState = {};
        const state: CodexRuntimeSessionState = {
          threadId:
            ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "",
        };
        const sessionDir = ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("codex");
        const codexHome = await prepareManagedCodexHome({
          agent: ctx.agent,
          sessionDir,
          env: options.env,
          logger: ctx.logger,
        });
        if (state.threadId !== "") {
          const exists = await nativeSessionFileExists(join(codexHome, "sessions"), state.threadId);
          if (!exists) {
            throw new Error(`Codex runtime session file was not found: ${state.threadId}.`);
          }
        }
        let mcpToolRegistry: McpToolRegistry | undefined;
        let workflowToolsMcpServer: CodexWorkflowToolsMcpServer | undefined;
        let client: CodexAppServerClient | undefined;

        try {
          mcpToolRegistry = await createMcpToolRegistry(ctx.agent.mcp);
          workflowToolsMcpServer = await createCodexWorkflowToolsMcpServer({
            agent: ctx.agent,
            getContext: () => ctx.lifecycle.currentContext,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            logger: ctx.logger,
            mcpTools: mcpToolRegistry.tools,
            state: toolRuntimeState,
            workflowExecution: ctx.request.workflowExecution,
          });
          client = await CodexAppServerClient.start({
            executablePath,
            args: createCodexAppServerArgs(
              options.appServerArgs ?? ["app-server", "--listen", "stdio://"],
              workflowToolsMcpServer,
            ),
            cwd: ctx.workspace,
            env: {
              ...(options.env ?? {}),
              CODEX_HOME: codexHome,
            },
            clientInfo: options.clientInfo ?? DEFAULT_CODEX_CLIENT_INFO,
            spawn: options.spawn,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            onNotification: notificationBus.publish,
            onStderr: (chunk) => {
              ctx.logger.debug("Codex app-server stderr", { chunk });
            },
          });
          const threadStartResult = await startOrResumeThread({
            client,
            runtimeSessionId: state.threadId,
            cwd: ctx.workspace,
            model: defaultModelName,
            thinkingLevel: options.defaultThinkingLevel,
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
              defaultThinkingLevel: options.defaultThinkingLevel,
              codexHome,
              startupMessages: threadStartResult.startedFreshThread
                ? ctx.agentContext.startupMessages
                : [],
            }),
            mcpToolRegistry,
            workflowToolsMcpServer,
          };
        } catch (error) {
          try {
            await disposeCodexRuntimeResources(
              client,
              workflowToolsMcpServer,
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
        const modelName = turn.modelName ?? session.defaultModelName;
        const thinkingLevel = turn.thinkingLevel ?? session.defaultThinkingLevel;
        if (modelName !== undefined || thinkingLevel !== undefined) {
          assertCodexModelSelection(await listModels(), modelName, thinkingLevel);
        }
        return await startCodexTurn(session, { ...turn, modelName, thinkingLevel });
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
      async destroySession(session, ctx) {
        await disposeCodexRuntimeResources(
          session.client,
          session.workflowToolsMcpServer,
          session.mcpToolRegistry,
          ctx.logger,
        );
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
    },
  );
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

function createCodexAppServerArgs(
  baseArgs: readonly string[],
  workflowToolsMcpServer: CodexWorkflowToolsMcpServer,
): readonly string[] {
  const serverKey = `mcp_servers.${workflowToolsMcpServer.id}`;

  return [
    ...baseArgs,
    "-c",
    `${serverKey}.url=${JSON.stringify(workflowToolsMcpServer.url)}`,
    "-c",
    `${serverKey}.enabled=true`,
    "-c",
    `${serverKey}.required=true`,
    "-c",
    `${serverKey}.default_tools_approval_mode="approve"`,
  ];
}

async function disposeCodexRuntimeResources(
  client: CodexAppServerClient | undefined,
  workflowToolsMcpServer: CodexWorkflowToolsMcpServer | undefined,
  mcpToolRegistry: McpToolRegistry | undefined,
  logger: ExpertAgentLogger,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => client?.close()),
    workflowToolsMcpServer?.dispose() ?? Promise.resolve(),
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
