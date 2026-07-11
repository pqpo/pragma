import { join } from "node:path";

import type {
  McpToolRegistry,
  RuntimeAdapter,
  RuntimeCanUseResult,
  WorkflowToolsMcpServer,
} from "@pragma/core";
import {
  createMcpToolRegistry,
  createWorkflowToolsMcpServer,
  defineRuntimeDriver,
  type ExpertAgentLogger,
  type RuntimeSessionPersistenceSpec,
  type WorkflowToolRuntimeState,
} from "@pragma/core";
import { prepareManagedClaudeCodeConfig } from "./claude-config.ts";
import { canUseClaudeCodeRuntime } from "./availability.ts";
import { materializeClaudeCodePlugin } from "./skills.ts";
import {
  cancelClaudeCodeTurn,
  collectClaudeCodeUsage,
  consumeClaudeCodeStartupMessages,
  createClaudeCodeNativeSession,
  listClaudeCodeMessages,
  mapClaudeCodeNativeEvent,
  startClaudeCodeTurn,
  type ClaudeCodeNativeSession,
} from "./session.ts";
import type { ClaudeCodeRuntimeAdapterOptions, ClaudeCodeRuntimeSessionState } from "./types.ts";
import {
  assertClaudeCodeModelSelection,
  assertClaudeCodeProviderConfig,
  createClaudeCodeModelDiscovery,
} from "./models.ts";

const CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR = {
  id: "claude-code-local",
  kind: "claude-code-local" as const,
  displayName: "Claude Code Local",
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
const DEFAULT_CLAUDE_CODE_PERMISSION_MODE = "auto" as const;

interface ClaudeCodeDriverSession extends ClaudeCodeNativeSession {
  readonly mcpToolRegistry: McpToolRegistry;
  readonly workflowToolsMcpServer: WorkflowToolsMcpServer;
}

export function createClaudeCodeRuntime(
  options: ClaudeCodeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const descriptor = {
    ...CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };
  const listModels = options.listModels ?? createClaudeCodeModelDiscovery(options);

  return defineRuntimeDriver(
    {
      descriptor,
      canUse: createClaudeCodeRuntimeCanUse(options),
      listModels,
      outputRetryLimit: options.outputRetryLimit,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: getClaudeCodeSessionDir(ctx.workspace, ctx.agent.id),
          watch: true,
          checkpointOn: [
            "session.created",
            "runtimeSessionId.changed",
            "turn.completed",
            "session.destroyed",
            "files.changed",
          ],
          metadata: {
            format: "claude-code-session-dir",
          },
        };
      },
      async createSession(ctx): Promise<ClaudeCodeDriverSession> {
        assertClaudeCodeProviderConfig(ctx.request);
        const defaultModelName = options.defaultModelName ?? ctx.agent.models?.defaultModelName;
        if (defaultModelName !== undefined || options.defaultThinkingLevel !== undefined) {
          assertClaudeCodeModelSelection(
            await listModels(),
            defaultModelName,
            options.defaultThinkingLevel,
          );
        }
        const sessionDir =
          ctx.persistence.spec?.sessionDir ?? getClaudeCodeSessionDir(ctx.workspace, ctx.agent.id);
        const state: ClaudeCodeRuntimeSessionState = {
          sessionId:
            ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "",
        };
        const toolRuntimeState: WorkflowToolRuntimeState = {};
        const pluginDir = await materializeClaudeCodePlugin({
          agent: ctx.agent,
          sessionDir,
        });
        const mcpToolRegistry = await createMcpToolRegistry(ctx.agent.mcp);
        const workflowToolsMcpServer = await createWorkflowToolsMcpServer({
          agent: ctx.agent,
          getContext: () => ctx.lifecycle.currentContext,
          humanInteractionHandler: ctx.request.humanInteractionHandler,
          logger: ctx.logger,
          mcpTools: mcpToolRegistry.tools,
          state: toolRuntimeState,
          workflowExecution: ctx.request.workflowExecution,
        });
        const isolationMode = options.isolationMode ?? "strict";
        const managedConfig =
          isolationMode === "strict"
            ? await prepareManagedClaudeCodeConfig({
                sessionDir,
                env: options.env,
                logger: ctx.logger,
              })
            : undefined;

        return {
          ...createClaudeCodeNativeSession({
            agent: ctx.agent,
            executablePath: options.executablePath ?? "claude",
            additionalArgs: options.additionalArgs ?? [],
            defaultModelName,
            defaultThinkingLevel: options.defaultThinkingLevel,
            env: options.env,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            isolationMode,
            logger: ctx.logger,
            managedConfig,
            mcpServerUrl: workflowToolsMcpServer.url,
            permissionMode: options.permissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
            pluginDir,
            sessionDir,
            spawn: options.spawn,
            startupMessages: state.sessionId === "" ? ctx.agentContext.startupMessages : [],
            state,
            systemPrompt: ctx.agentContext.systemPrompt,
          }),
          mcpToolRegistry,
          workflowToolsMcpServer,
        };
      },
      readSession(session) {
        return {
          runtimeSessionId: session.state.sessionId,
        };
      },
      listMessages: listClaudeCodeMessages,
      consumeStartupMessages: consumeClaudeCodeStartupMessages,
      async startTurn(session, turn) {
        const modelName = turn.modelName ?? session.defaultModelName;
        const thinkingLevel = turn.thinkingLevel ?? session.defaultThinkingLevel;
        if (modelName !== undefined || thinkingLevel !== undefined) {
          assertClaudeCodeModelSelection(await listModels(), modelName, thinkingLevel);
        }
        return await startClaudeCodeTurn(session, { ...turn, modelName, thinkingLevel });
      },
      mapEvent: mapClaudeCodeNativeEvent,
      async collectUsage(session, ctx) {
        return await collectClaudeCodeUsage(session, ctx.startedAt, ctx.usage);
      },
      cancelTurn(session) {
        cancelClaudeCodeTurn(session);
      },
      async destroySession(session, ctx) {
        cancelClaudeCodeTurn(session);
        await disposeClaudeRuntimeResources(
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

function createClaudeCodeRuntimeCanUse(
  options: ClaudeCodeRuntimeAdapterOptions,
): () => Promise<RuntimeCanUseResult> | RuntimeCanUseResult {
  if (options.canUse !== undefined) {
    return options.canUse;
  }

  if (options.spawn !== undefined) {
    return () => ({
      usable: true,
      details: {
        probe: "skipped",
        reason: "Custom Claude Code spawn was provided.",
      },
    });
  }

  return async () =>
    await canUseClaudeCodeRuntime({
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
}

async function disposeClaudeRuntimeResources(
  workflowToolsMcpServer: WorkflowToolsMcpServer | undefined,
  mcpToolRegistry: McpToolRegistry | undefined,
  logger: ExpertAgentLogger,
): Promise<void> {
  const results = await Promise.allSettled([
    workflowToolsMcpServer?.dispose() ?? Promise.resolve(),
    mcpToolRegistry?.dispose() ?? Promise.resolve(),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );

  if (errors.length === 0) {
    return;
  }

  logger.error("Claude Code runtime cleanup failed", { errors });

  if (errors.length === 1) {
    throw errors[0];
  }

  throw new AggregateError(errors, "Claude Code runtime session cleanup failed.");
}

function getClaudeCodeSessionDir(workspace: string, agentId: string): string {
  return join(workspace, ".pragma", "runtime-sessions", "claude-code", agentId);
}
