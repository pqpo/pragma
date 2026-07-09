import { join } from "node:path";

import type { McpToolRegistry, RuntimeAdapter } from "@pragma/core";
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

export function createCodexLocalRuntimeAdapter(
  options: CodexRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const descriptor = {
    ...CODEX_LOCAL_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CODEX_LOCAL_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CODEX_LOCAL_RUNTIME_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };

  return defineRuntimeDriver(
    {
      descriptor,
      outputRetryLimit: options.outputRetryLimit,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: getCodexSessionDir(ctx.workspace, ctx.agent.id),
          checkpointOn: ["session.created", "turn.completed", "session.destroyed"],
          metadata: {
            format: "codex-managed-home",
          },
        };
      },
      async createSession(ctx): Promise<CodexDriverSession> {
        const notificationBus = createCodexNotificationBus();
        const toolRuntimeState: CodexWorkflowToolRuntimeState = {};
        const state: CodexRuntimeSessionState = {
          threadId:
            ctx.persistence.restoredRuntimeSessionId ??
            (ctx.request.runtimeSession?.type === descriptor.kind ? ctx.request.runtimeSession.id : "") ??
            "",
        };
        const sessionDir = ctx.persistence.spec?.sessionDir ?? getCodexSessionDir(ctx.workspace, ctx.agent.id);
        const codexHome = await prepareManagedCodexHome({
          agent: ctx.agent,
          sessionDir,
          env: options.env,
          logger: ctx.logger,
        });
        const mcpToolRegistry = await createMcpToolRegistry(ctx.agent.mcp);
        const workflowToolsMcpServer = await createCodexWorkflowToolsMcpServer({
          agent: ctx.agent,
          getContext: () => ctx.lifecycle.currentContext,
          humanInteractionHandler: ctx.request.humanInteractionHandler,
          logger: ctx.logger,
          mcpTools: mcpToolRegistry.tools,
          state: toolRuntimeState,
          workflowExecution: ctx.request.workflowExecution,
        });
        const client = await CodexAppServerClient.start({
          executablePath: options.executablePath ?? "codex",
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
          model: options.defaultModelName ?? ctx.agent.models?.defaultModelName,
          developerInstructions: ctx.agentContext.systemPrompt,
          sandboxMode: options.sandboxMode,
          approvalPolicy: options.approvalPolicy,
          logger: ctx.logger,
        });
        state.threadId = threadStartResult.threadId;

        return {
          ...createCodexNativeSession({
            client,
            notificationBus,
            state,
            defaultModelName: options.defaultModelName ?? ctx.agent.models?.defaultModelName,
            codexHome,
            startupMessages: threadStartResult.startedFreshThread
              ? ctx.agentContext.startupMessages
              : [],
          }),
          mcpToolRegistry,
          workflowToolsMcpServer,
        };
      },
      readSession(session) {
        return {
          runtimeSessionId: session.state.threadId,
        };
      },
      listMessages: listCodexMessages,
      consumeStartupMessages: consumeCodexStartupMessages,
      startTurn: startCodexTurn,
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
  developerInstructions,
  sandboxMode,
  approvalPolicy,
  logger,
}: {
  readonly client: CodexAppServerClient;
  readonly runtimeSessionId: string;
  readonly cwd: string;
  readonly model?: string | undefined;
  readonly developerInstructions?: string | undefined;
  readonly sandboxMode?: string | undefined;
  readonly approvalPolicy?: string | undefined;
  readonly logger: Pick<ExpertAgentLogger, "warn">;
}): Promise<{
  readonly threadId: string;
  readonly startedFreshThread: boolean;
}> {
  if (runtimeSessionId !== "") {
    try {
      const threadId = await client.resumeThread(runtimeSessionId, {
        cwd,
        model,
        developerInstructions,
      });
      return {
        threadId,
        startedFreshThread: false,
      };
    } catch (error) {
      logger.warn("Codex thread resume failed; starting a fresh thread", {
        threadId: runtimeSessionId,
        error,
      });
    }
  }

  const threadId = await client.startThread({
    cwd,
    model,
    developerInstructions,
    sandboxMode,
    approvalPolicy,
  });
  return {
    threadId,
    startedFreshThread: true,
  };
}

function getCodexSessionDir(workspace: string, agentId: string): string {
  return join(workspace, ".pragma", "runtime-sessions", "codex", agentId);
}
