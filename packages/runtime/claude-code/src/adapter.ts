import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  McpToolRegistry,
  RuntimeAdapter,
  RuntimeSessionRestoreHandler,
  RuntimeSessionStorageContext,
  RuntimeSessionSyncCallback,
  WorkflowToolRuntimeState,
  WorkflowToolsMcpServer,
} from "@pragma/core";
import type { ExpertAgentRunContext } from "@pragma/core";
import { createExpertAgentLogger } from "@pragma/core";
import { createExpertAgentRunContext } from "@pragma/core";
import { createMcpToolRegistry } from "@pragma/core";
import { createQueuedAgentLifecycle } from "@pragma/core";
import { createWorkflowToolsMcpServer } from "@pragma/core";
import { dispatchExpertAgentHook } from "@pragma/core";
import { materializeClaudeCodePlugin } from "./skills.ts";
import { createClaudeCodeRuntimeSession } from "./session.ts";
import type { ClaudeCodeRuntimeAdapterOptions, ClaudeCodeRuntimeSessionState } from "./types.ts";

const CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR = {
  id: "claude-code-local",
  kind: "claude-code-local" as const,
  displayName: "Claude Code Local",
  capabilities: {
    targets: ["agent"],
    executionLocations: ["local"],
    supportsAbort: true,
    supportsMcp: true,
    supportsStreaming: true,
  },
};

export function createClaudeCodeLocalRuntimeAdapter(
  options: ClaudeCodeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  let sessionSyncCallback = options.sessionSyncCallback;
  let sessionRestoreHandler = options.sessionRestoreHandler;
  const descriptor = {
    ...CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR.capabilities,
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
      const toolRuntimeState: WorkflowToolRuntimeState = {};
      let mcpToolRegistry: McpToolRegistry | undefined;
      let workflowToolsMcpServer: WorkflowToolsMcpServer | undefined;
      let activeSessionSyncCallback: RuntimeSessionSyncCallback | undefined;
      let sessionStorageContext: RuntimeSessionStorageContext | undefined;
      let sessionDir: string | undefined;
      const state: ClaudeCodeRuntimeSessionState = {
        sessionId:
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
        abort: async () => undefined,
        cleanup: async () => {
          const sessionInfo = {
            systemSessionId,
            runtimeSession: {
              type: descriptor.kind,
              id: state.sessionId,
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
          await disposeClaudeRuntimeResources(workflowToolsMcpServer, mcpToolRegistry).catch(
            (error: unknown) => {
              cleanupErrors.push(error);
            },
          );
          if (activeSessionSyncCallback !== undefined && sessionDir !== undefined) {
            await syncRuntimeSession(
              activeSessionSyncCallback,
              createSessionStorageContext({
                agentId: agent.id,
                context: runContext,
                runtime: descriptor,
                runtimeSessionId: state.sessionId,
                sessionDir,
                systemSessionId,
                workspace: agent.workspace,
              }),
              logger,
            ).catch((error: unknown) => {
              cleanupErrors.push(error);
            });
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
        sessionDir = getClaudeCodeSessionDir(agent.workspace, agent.id);
        await mkdir(sessionDir, { recursive: true });
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
        const pluginDir = await materializeClaudeCodePlugin({ agent, sessionDir });

        mcpToolRegistry = await createMcpToolRegistry(agent.mcp);
        workflowToolsMcpServer = await createWorkflowToolsMcpServer({
          agent,
          getContext: () => lifecycle.currentContext,
          humanInteractionHandler,
          logger,
          mcpTools: mcpToolRegistry.tools,
          state: toolRuntimeState,
          workflowExecution,
        });
        sessionStorageContext = createSessionStorageContext({
          agentId: agent.id,
          context: runContext,
          runtime: descriptor,
          runtimeSessionId: state.sessionId,
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
            id: state.sessionId,
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

        return createClaudeCodeRuntimeSession({
          agent,
          executablePath: options.executablePath ?? "claude",
          additionalArgs: options.additionalArgs ?? [],
          defaultModelName: options.defaultModelName ?? agent.models?.defaultModelName,
          env: options.env,
          humanInteractionHandler,
          info: sessionInfo,
          isolationMode: options.isolationMode ?? "strict",
          lifecycle,
          logger,
          mcpServerUrl: workflowToolsMcpServer.url,
          outputRetryLimit: options.outputRetryLimit,
          permissionMode: options.permissionMode ?? "default",
          pluginDir,
          sessionDir,
          sessionStorageContext,
          sessionSyncCallback: activeSessionSyncCallback,
          spawn: options.spawn,
          startupMessages: state.sessionId === "" ? context.startupMessages : [],
          state,
          toolRuntimeState,
        });
      } catch (error) {
        logger.error("Claude Code runtime session creation failed", { error });
        await disposeClaudeRuntimeResources(workflowToolsMcpServer, mcpToolRegistry).catch(
          (cleanupError: unknown) => {
            logger.error("Claude Code runtime session creation cleanup failed", {
              error: cleanupError,
            });
          },
        );
        await dispatchExpertAgentHook(agent.hooks, "afterSessionDestroy", {
          agent,
          session: {
            systemSessionId,
            runtimeSession: {
              type: descriptor.kind,
              id: state.sessionId,
            },
            agentId: agent.id,
            runtime: descriptor,
            sessionState: lifecycle.sessionState,
            runState: lifecycle.runState,
          },
          logger,
        }).catch((cleanupError: unknown) => {
          logger.error("Claude Code runtime session failure hook failed", { error: cleanupError });
        });
        throw error;
      }
    },
  };
}

async function disposeClaudeRuntimeResources(
  workflowToolsMcpServer: WorkflowToolsMcpServer | undefined,
  mcpToolRegistry: McpToolRegistry | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    workflowToolsMcpServer?.dispose() ?? Promise.resolve(),
    mcpToolRegistry?.dispose() ?? Promise.resolve(),
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

  throw new AggregateError(errors, "Claude Code runtime session cleanup failed.");
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
    logger.error("Claude Code runtime session sync callback failed", {
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

function getClaudeCodeSessionDir(workspace: string, agentId: string): string {
  return join(workspace, ".pragma", "runtime-sessions", "claude-code", agentId);
}
