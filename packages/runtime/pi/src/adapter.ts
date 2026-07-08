import { AuthStorage, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type {
  ExpertAgentStartupMessage,
  ExpertAgentLogger,
  ExpertAgentRunContext,
  RuntimeAdapter,
  RuntimeSessionRestoreHandler,
  RuntimeSessionStorageContext,
  RuntimeSessionSyncCallback,
} from "@pragma/core";
import {
  createExpertAgentLogger,
  createExpertAgentRunContext,
  createQueuedAgentLifecycle,
  dispatchExpertAgentHook,
} from "@pragma/core";
import { randomUUID } from "node:crypto";

import { createMcpToolRegistry } from "@pragma/core";
import type { McpToolRegistry } from "@pragma/core";
import {
  collectRuntimeModelProviders,
  createPiModelRegistry,
  getRuntimeModelName,
  resolveRequiredRuntimeModel,
} from "./models.ts";
import { createResourceLoader } from "./resources.ts";
import { createPiRuntimeSession } from "./session.ts";
import { createPiSessionManager, getPiSessionDir } from "./session-manager.ts";
import { ensureSessionDir, sessionDirExists, watchRuntimeSessionDir } from "./session-storage.ts";
import type { RuntimeSessionWatcher } from "./session-storage.ts";
import { createResolvedPiTools } from "./tools.ts";
import type { CloudPiRuntimeAdapterOptions, PiRuntimeStreamState } from "./types.ts";
import { defaultOutputParser } from "./types.ts";

const CLOUD_PI_RUNTIME_DESCRIPTOR = {
  id: "cloud-pi-agent",
  kind: "cloud-pi-agent" as const,
  displayName: "Cloud PI Agent",
  capabilities: {
    targets: ["agent"],
    executionLocations: ["cloud"],
    supportsAbort: true,
    supportsMcp: true,
    supportsStreaming: true,
  },
};

export function createCloudPiRuntimeAdapter(
  options: CloudPiRuntimeAdapterOptions = {},
): RuntimeAdapter {
  let sessionSyncCallback = options.sessionSyncCallback;
  let sessionRestoreHandler = options.sessionRestoreHandler;
  const descriptor = {
    ...CLOUD_PI_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CLOUD_PI_RUNTIME_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };

  return {
    descriptor,
    setSessionSyncCallback(callback) {
      sessionSyncCallback = callback;
    },
    setSessionRestoreHandler(handler) {
      sessionRestoreHandler = handler;
    },
    async createSession({
      agent,
      context: requestedRunContext,
      humanInteractionHandler,
      models,
      runtimeSession,
      systemSessionId: requestedSystemSessionId,
      workflowExecution,
      loggerProvider: requestedLoggerProvider,
    }) {
      const systemSessionId = requestedSystemSessionId ?? randomUUID();
      const runContext = createExpertAgentRunContext(requestedRunContext);
      const loggerProvider =
        requestedLoggerProvider ?? options.loggerProvider ?? agent.loggerProvider;
      const logger = createExpertAgentLogger(loggerProvider, {
        component: "runtime-adapter",
        agentId: agent.id,
        runtimeId: descriptor.id,
      });
      logger.info("Creating runtime session", {
        systemSessionId,
        runtimeSessionId: runtimeSession?.id,
      });
      await dispatchExpertAgentHook(agent.hooks, "beforeSessionCreate", {
        agent,
        context: runContext,
        systemSessionId,
        runtimeSession,
        logger,
      });
      let piSession: AgentSession | undefined;
      let mcpToolRegistry: McpToolRegistry | undefined;
      let lifecycle:
        ReturnType<typeof createQueuedAgentLifecycle<ExpertAgentRunContext>> | undefined;
      let sessionWatcher: RuntimeSessionWatcher | undefined;
      let sessionStorageContext: RuntimeSessionStorageContext | undefined;
      let activeSessionSyncCallback: RuntimeSessionSyncCallback | undefined;

      try {
        const authStorage = AuthStorage.create();
        const cwd = agent.workspace;
        const sessionDir = getPiSessionDir(cwd, agent.id);
        await ensureSessionDir(sessionDir);
        await restoreRuntimeSession({
          agentId: agent.id,
          context: runContext,
          handler: sessionRestoreHandler,
          runtimeSession,
          sessionDir,
          systemSessionId,
          workspace: cwd,
        });
        logger.debug("Creating runtime model registry", { cwd });
        const modelRegistry = createPiModelRegistry(
          authStorage,
          collectRuntimeModelProviders(agent, models),
        );
        const context = await agent.buildContext(runContext);
        const loader = createResourceLoader(agent, cwd, context.systemPrompt);
        await loader.reload();
        mcpToolRegistry = await createMcpToolRegistry(agent.mcp);
        const streamState: PiRuntimeStreamState = { logger };
        lifecycle = createQueuedAgentLifecycle<ExpertAgentRunContext>(runContext, {
          abort: async () => {
            logger.warn("Aborting runtime session", { systemSessionId });
            await piSession?.abort();
          },
          cleanup: async () => {
            const sessionInfo = createSessionInfo({
              systemSessionId,
              runtimeSession,
              agentId: agent.id,
              piSession,
              lifecycle,
            });
            await dispatchExpertAgentHook(agent.hooks, "beforeSessionDestroy", {
              agent,
              session: sessionInfo,
              logger,
            });
            piSession?.dispose();
            sessionWatcher?.close();
            await mcpToolRegistry?.dispose();
            if (activeSessionSyncCallback !== undefined && sessionStorageContext !== undefined) {
              await syncRuntimeSession(activeSessionSyncCallback, sessionStorageContext, logger);
            }
            await dispatchExpertAgentHook(agent.hooks, "afterSessionDestroy", {
              agent,
              session: sessionInfo,
              logger,
            });
            logger.info("Runtime session destroyed", {
              systemSessionId,
              runtimeSessionId: sessionInfo.runtimeSession.id,
            });
          },
        });
        const resolvedTools = createResolvedPiTools({
          agent,
          authStorage,
          cwd,
          mcpTools: mcpToolRegistry.tools,
          modelRegistry,
          parentSystemPrompt: context.systemPrompt,
          streamState,
          lifecycle,
          context: runContext,
          workflowExecution,
          humanInteractionHandler,
        });

        const piSessionManagerResult = await createPiSessionManager(
          cwd,
          agent.id,
          runtimeSession,
          descriptor.kind,
        );
        const sessionOptions: CreateAgentSessionOptions = {
          cwd,
          authStorage,
          modelRegistry,
          resourceLoader: loader,
          sessionManager: piSessionManagerResult.sessionManager,
        };
        const defaultModel = resolveRequiredRuntimeModel(
          getRuntimeModelName(agent, undefined),
          modelRegistry,
          "agent default",
        );

        if (defaultModel !== undefined) {
          sessionOptions.model = defaultModel;
        }

        if (resolvedTools.tools.length > 0) {
          sessionOptions.customTools = resolvedTools.tools.map((tool) => tool.tool);
        }

        const { session } = await createAgentSession(sessionOptions);
        piSession = session;
        if (!piSessionManagerResult.resumedExistingSession) {
          appendStartupMessages(session, context.startupMessages);
        }
        sessionStorageContext = createSessionStorageContext({
          agentId: agent.id,
          context: runContext,
          runtimeSessionId: session.sessionId,
          sessionDir,
          systemSessionId,
          workspace: cwd,
        });
        activeSessionSyncCallback = sessionSyncCallback;
        if (activeSessionSyncCallback !== undefined && (await sessionDirExists(sessionDir))) {
          sessionWatcher = watchRuntimeSessionDir({
            context: sessionStorageContext,
            callback: activeSessionSyncCallback,
            debounceMs: options.sessionSyncDebounceMs,
            logger,
          });
          await syncRuntimeSession(activeSessionSyncCallback, sessionStorageContext, logger);
        }
        const sessionInfo = {
          systemSessionId,
          runtimeSession: {
            type: descriptor.kind,
            id: session.sessionId,
          },
          agentId: agent.id,
          runtime: descriptor,
        };

        await dispatchExpertAgentHook(agent.hooks, "afterSessionCreate", {
          agent,
          session: {
            ...sessionInfo,
            sessionState: lifecycle.sessionState,
            runState: lifecycle.runState,
          },
          logger,
        });
        logger.info("Runtime session created", {
          systemSessionId,
          runtimeSessionId: session.sessionId,
        });

        return createPiRuntimeSession(
          agent,
          session,
          sessionInfo,
          options.outputParser ?? defaultOutputParser,
          lifecycle,
          streamState,
          {
            defaultModelName: agent.models?.defaultModelName,
            modelRegistry,
          },
          {
            outputRetryLimit: options.outputRetryLimit,
          },
        );
      } catch (error) {
        logger.error("Runtime session creation failed", {
          systemSessionId,
          error,
        });
        sessionWatcher?.close();
        if (lifecycle === undefined) {
          await mcpToolRegistry?.dispose();
          await dispatchExpertAgentHook(agent.hooks, "afterSessionDestroy", {
            agent,
            session: createSessionInfo({
              systemSessionId,
              runtimeSession,
              agentId: agent.id,
              piSession,
              lifecycle,
            }),
            logger,
          });
        } else {
          await lifecycle.abort();
        }
        throw error;
      }
    },
  };
}

function appendStartupMessages(
  session: AgentSession,
  messages: readonly ExpertAgentStartupMessage[],
): void {
  if (messages.length === 0) {
    return;
  }

  const timestamp = Date.now();
  const piMessages = messages.map((message, index) => ({
    role: message.role,
    content: message.content,
    timestamp: timestamp + index,
  }));
  const mutableSession = session as unknown as {
    readonly state?: { messages: unknown[] } | undefined;
    messages: unknown[];
  };
  const nextMessages = [...mutableSession.messages, ...piMessages];

  if (mutableSession.state !== undefined) {
    mutableSession.state.messages = nextMessages;
    return;
  }

  mutableSession.messages = nextMessages;
}

async function restoreRuntimeSession({
  agentId,
  context,
  handler,
  runtimeSession,
  sessionDir,
  systemSessionId,
  workspace,
}: {
  readonly agentId: string;
  readonly context: ExpertAgentRunContext;
  readonly handler: RuntimeSessionRestoreHandler | undefined;
  readonly runtimeSession?: { readonly type: string; readonly id: string } | undefined;
  readonly sessionDir: string;
  readonly systemSessionId: string;
  readonly workspace: string;
}): Promise<void> {
  if (
    handler === undefined ||
    runtimeSession === undefined ||
    runtimeSession.type !== CLOUD_PI_RUNTIME_DESCRIPTOR.kind
  ) {
    return;
  }

  const storageContext = createSessionStorageContext({
    agentId,
    context,
    runtimeSessionId: runtimeSession.id,
    sessionDir,
    systemSessionId,
    workspace,
  });
  await ensureSessionDir(sessionDir);
  await handler(storageContext);
}

async function syncRuntimeSession(
  callback: RuntimeSessionSyncCallback,
  context: RuntimeSessionStorageContext,
  logger: ExpertAgentLogger,
): Promise<void> {
  try {
    await callback(context);
  } catch (error) {
    logger.error("Runtime session sync callback failed", {
      agentId: context.agentId,
      runtimeSessionId: context.runtimeSession.id,
      sessionDir: context.sessionDir,
      error,
    });
  }
}

function createSessionStorageContext({
  agentId,
  context,
  runtimeSessionId,
  sessionDir,
  systemSessionId,
  workspace,
}: {
  readonly agentId: string;
  readonly context: ExpertAgentRunContext;
  readonly runtimeSessionId: string;
  readonly sessionDir: string;
  readonly systemSessionId: string;
  readonly workspace: string;
}): RuntimeSessionStorageContext {
  return {
    agentId,
    context,
    runtime: CLOUD_PI_RUNTIME_DESCRIPTOR,
    runtimeSession: {
      type: CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
      id: runtimeSessionId,
    },
    sessionDir,
    systemSessionId,
    workspace,
  };
}

function createSessionInfo({
  systemSessionId,
  runtimeSession,
  agentId,
  piSession,
  lifecycle,
}: {
  readonly systemSessionId: string;
  readonly runtimeSession?: { readonly type: string; readonly id: string } | undefined;
  readonly agentId: string;
  readonly piSession?: AgentSession | undefined;
  readonly lifecycle?:
    ReturnType<typeof createQueuedAgentLifecycle<ExpertAgentRunContext>> | undefined;
}) {
  return {
    systemSessionId,
    runtimeSession: {
      type: CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
      id:
        piSession?.sessionId ??
        (runtimeSession?.type === CLOUD_PI_RUNTIME_DESCRIPTOR.kind ? runtimeSession.id : ""),
    },
    agentId,
    runtime: CLOUD_PI_RUNTIME_DESCRIPTOR,
    sessionState: lifecycle?.sessionState ?? "closed",
    runState: lifecycle?.runState,
  };
}
