import { randomUUID } from "node:crypto";
import { join } from "node:path";

import type {
  RuntimeAdapter,
  RuntimeSessionRestoreHandler,
  RuntimeSessionStorageContext,
  RuntimeSessionSyncCallback,
} from "../runtime/runtime-adapter.ts";
import type { ExpertAgentStartupMessage } from "../agent/context-manager.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import { createExpertAgentLogger, type ExpertAgentLogger } from "../logging/logger.ts";
import { createExpertAgentRunContext } from "../runtime/run-context.ts";
import { createQueuedAgentLifecycle } from "../runtime/agent-lifecycle.ts";
import { dispatchExpertAgentHook } from "../plugins/expert-agent-plugin.ts";
import { CodexAppServerClient } from "./app-server-client.ts";
import type { CodexAppServerNotification } from "./app-server-client.ts";
import { createCodexRuntimeSession } from "./session.ts";
import type { CodexNotificationSubscriber, CodexRuntimeSessionState } from "./session.ts";
import type { CodexRuntimeAdapterOptions } from "./types.ts";
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
    supportsStreaming: true,
    supportsSubAgents: false,
  },
};

const DEFAULT_CODEX_CLIENT_INFO = {
  name: "pragma_codex_runtime",
  title: "Pragma Codex Runtime",
  version: "0.1.0",
};

export function createCodexLocalRuntimeAdapter(
  options: CodexRuntimeAdapterOptions = {},
): RuntimeAdapter {
  let sessionSyncCallback = options.sessionSyncCallback;
  let sessionRestoreHandler = options.sessionRestoreHandler;
  const descriptor = {
    ...CODEX_LOCAL_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CODEX_LOCAL_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CODEX_LOCAL_RUNTIME_DESCRIPTOR.capabilities,
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
      runtimeSession,
      systemSessionId: requestedSystemSessionId,
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
      const notificationBus = createNotificationBus();
      const toolRuntimeState: CodexWorkflowToolRuntimeState = {};
      let client: CodexAppServerClient | undefined;
      let workflowToolsMcpServer: CodexWorkflowToolsMcpServer | undefined;
      let activeSessionSyncCallback: RuntimeSessionSyncCallback | undefined;
      let sessionStorageContext: RuntimeSessionStorageContext | undefined;
      const state: CodexRuntimeSessionState = {
        threadId:
          runtimeSession?.type === descriptor.kind && runtimeSession.id !== ""
            ? runtimeSession.id
            : "",
      };

      await dispatchExpertAgentHook(agent.hooks, "beforeSessionCreate", {
        agent,
        context: runContext,
        systemSessionId,
        runtimeSession,
        logger,
      });

      const lifecycle = createQueuedAgentLifecycle<ExpertAgentRunContext | undefined>(runContext, {
        abort: async () => {
          client?.close();
        },
        cleanup: async () => {
          const sessionInfo = {
            systemSessionId,
            runtimeSession: {
              type: descriptor.kind,
              id: state.threadId,
            },
            agentId: agent.id,
            runtime: descriptor,
            sessionState: lifecycle.sessionState,
            runState: lifecycle.runState,
          };
          const cleanupErrors: unknown[] = [];

          await dispatchExpertAgentHook(agent.hooks, "beforeSessionDestroy", {
            agent,
            session: sessionInfo,
            logger,
          }).catch((error: unknown) => {
            cleanupErrors.push(error);
          });
          await disposeCodexRuntimeResources(client, workflowToolsMcpServer).catch(
            (error: unknown) => {
              cleanupErrors.push(error);
            },
          );
          if (activeSessionSyncCallback !== undefined && sessionStorageContext !== undefined) {
            await syncRuntimeSession(activeSessionSyncCallback, sessionStorageContext, logger).catch(
              (error: unknown) => {
                cleanupErrors.push(error);
              },
            );
          }
          await dispatchExpertAgentHook(agent.hooks, "afterSessionDestroy", {
            agent,
            session: sessionInfo,
            logger,
          }).catch((error: unknown) => {
            cleanupErrors.push(error);
          });

          throwIfCleanupFailed(cleanupErrors);
        },
      });
      try {
        const sessionDir = getCodexSessionDir(agent.workspace, agent.id);
        await restoreRuntimeSession({
          agentId: agent.id,
          context: runContext,
          handler: sessionRestoreHandler,
          runtime: descriptor,
          runtimeSession,
          sessionDir,
          systemSessionId,
          workspace: agent.workspace,
        });
        const context = await agent.buildContext(runContext);
        workflowToolsMcpServer = await createCodexWorkflowToolsMcpServer({
          agent,
          getContext: () => lifecycle.currentContext,
          humanInteractionHandler,
          logger,
          state: toolRuntimeState,
        });
        client = await CodexAppServerClient.start({
          executablePath: options.executablePath ?? "codex",
          args: createCodexAppServerArgs(
            options.appServerArgs ?? ["app-server", "--listen", "stdio://"],
            workflowToolsMcpServer,
          ),
          cwd: agent.workspace,
          env: options.env ?? {},
          clientInfo: options.clientInfo ?? DEFAULT_CODEX_CLIENT_INFO,
          spawn: options.spawn,
          humanInteractionHandler,
          onNotification: notificationBus.publish,
          onStderr: (chunk) => {
            logger.debug("Codex app-server stderr", { chunk });
          },
        });
        state.threadId = await startOrResumeThread({
          client,
          runtimeSession,
          runtimeKind: descriptor.kind,
          cwd: agent.workspace,
          model: options.defaultModelName ?? agent.models?.defaultModelName,
          developerInstructions: createCodexDeveloperInstructions(
            context.systemPrompt,
            context.startupMessages,
          ),
          sandboxMode: options.sandboxMode,
          approvalPolicy: options.approvalPolicy,
          logger,
        });
        sessionStorageContext = createSessionStorageContext({
          agentId: agent.id,
          context: runContext,
          runtime: descriptor,
          runtimeSessionId: state.threadId,
          sessionDir,
          systemSessionId,
          workspace: agent.workspace,
        });
        activeSessionSyncCallback = sessionSyncCallback;

        if (activeSessionSyncCallback !== undefined) {
          await syncRuntimeSession(activeSessionSyncCallback, sessionStorageContext, logger);
        }

        const sessionInfo = {
          systemSessionId,
          runtimeSession: {
            type: descriptor.kind,
            id: state.threadId,
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

        return createCodexRuntimeSession({
          agent,
          client,
          info: sessionInfo,
          lifecycle,
          logger,
          notificationBus,
          state,
          defaultModelName: options.defaultModelName ?? agent.models?.defaultModelName,
          outputRetryLimit: options.outputRetryLimit,
          codexHome: options.env?.CODEX_HOME,
          toolRuntimeState,
        });
      } catch (error) {
        logger.error("Codex runtime session creation failed", { error });
        await disposeCodexRuntimeResources(client, workflowToolsMcpServer).catch(
          (cleanupError: unknown) => {
            logger.error("Codex runtime session creation cleanup failed", { error: cleanupError });
          },
        );
        await dispatchExpertAgentHook(agent.hooks, "afterSessionDestroy", {
          agent,
          session: {
            systemSessionId,
            runtimeSession: {
              type: descriptor.kind,
              id: state.threadId,
            },
            agentId: agent.id,
            runtime: descriptor,
            sessionState: lifecycle.sessionState,
            runState: lifecycle.runState,
          },
          logger,
        }).catch((cleanupError: unknown) => {
          logger.error("Codex runtime session failure hook failed", { error: cleanupError });
        });
        throw error;
      }
    },
  };
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
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(() => client?.close()),
    workflowToolsMcpServer?.dispose() ?? Promise.resolve(),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );

  throwIfCleanupFailed(errors);
}

function throwIfCleanupFailed(errors: readonly unknown[]): void {
  if (errors.length === 0) {
    return;
  }

  if (errors.length === 1) {
    throw errors[0];
  }

  throw new AggregateError(errors, "Codex runtime session cleanup failed.");
}

function createCodexDeveloperInstructions(
  systemPrompt: string,
  startupMessages: readonly ExpertAgentStartupMessage[],
): string {
  if (startupMessages.length === 0) {
    return systemPrompt;
  }

  return [
    systemPrompt,
    "Startup reference messages:",
    ...startupMessages.map((message) => message.content),
  ].join("\n\n");
}

function createNotificationBus(): {
  readonly publish: (notification: CodexAppServerNotification) => void;
  readonly subscribe: (subscriber: CodexNotificationSubscriber) => () => void;
} {
  const subscribers = new Set<CodexNotificationSubscriber>();

  return {
    publish(notification) {
      for (const subscriber of subscribers) {
        subscriber(notification);
      }
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => {
        subscribers.delete(subscriber);
      };
    },
  };
}

async function startOrResumeThread({
  client,
  runtimeSession,
  runtimeKind,
  cwd,
  model,
  developerInstructions,
  sandboxMode,
  approvalPolicy,
  logger,
}: {
  readonly client: CodexAppServerClient;
  readonly runtimeSession?: { readonly type: string; readonly id: string } | undefined;
  readonly runtimeKind: string;
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly developerInstructions?: string | undefined;
  readonly sandboxMode?: string | undefined;
  readonly approvalPolicy?: string | undefined;
  readonly logger: Pick<ExpertAgentLogger, "warn">;
}): Promise<string> {
  if (runtimeSession?.type === runtimeKind && runtimeSession.id !== "") {
    try {
      return await client.resumeThread(runtimeSession.id, {
        cwd,
        model,
        developerInstructions,
      });
    } catch (error) {
      logger.warn("Codex thread resume failed; starting a fresh thread", {
        threadId: runtimeSession.id,
        error,
      });
    }
  }

  return await client.startThread({
    cwd,
    model,
    developerInstructions,
    sandboxMode,
    approvalPolicy,
  });
}

async function restoreRuntimeSession({
  agentId,
  context,
  handler,
  runtime,
  runtimeSession,
  sessionDir,
  systemSessionId,
  workspace,
}: {
  readonly agentId: string;
  readonly context: ExpertAgentRunContext;
  readonly handler: RuntimeSessionRestoreHandler | undefined;
  readonly runtime: RuntimeSessionStorageContext["runtime"];
  readonly runtimeSession?: { readonly type: string; readonly id: string } | undefined;
  readonly sessionDir: string;
  readonly systemSessionId: string;
  readonly workspace: string;
}): Promise<void> {
  if (
    handler === undefined ||
    runtimeSession === undefined ||
    runtimeSession.type !== runtime.kind ||
    runtimeSession.id === ""
  ) {
    return;
  }

  await handler(
    createSessionStorageContext({
      agentId,
      context,
      runtime,
      runtimeSessionId: runtimeSession.id,
      sessionDir,
      systemSessionId,
      workspace,
    }),
  );
}

async function syncRuntimeSession(
  callback: RuntimeSessionSyncCallback,
  context: RuntimeSessionStorageContext,
  logger: { readonly error: (message: string, attributes?: Record<string, unknown>) => void },
): Promise<void> {
  try {
    await callback(context);
  } catch (error) {
    logger.error("Codex runtime session sync callback failed", {
      runtimeSessionId: context.runtimeSession.id,
      error,
    });
  }
}

function createSessionStorageContext({
  agentId,
  context,
  runtime,
  runtimeSessionId,
  sessionDir,
  systemSessionId,
  workspace,
}: {
  readonly agentId: string;
  readonly context: ExpertAgentRunContext;
  readonly runtime: RuntimeSessionStorageContext["runtime"];
  readonly runtimeSessionId: string;
  readonly sessionDir: string;
  readonly systemSessionId: string;
  readonly workspace: string;
}): RuntimeSessionStorageContext {
  return {
    agentId,
    context,
    runtime,
    runtimeSession: {
      type: runtime.kind,
      id: runtimeSessionId,
    },
    sessionDir,
    systemSessionId,
    workspace,
  };
}

function getCodexSessionDir(workspace: string, agentId: string): string {
  return join(workspace, ".pragma", "runtime-sessions", "codex", agentId);
}
