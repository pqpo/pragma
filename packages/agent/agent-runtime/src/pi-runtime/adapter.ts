import { AuthStorage, createAgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ExpertAgentRunContext, RuntimeAdapter } from "@expertmesh/agent-core";
import {
  createExpertAgentLogger,
  createExpertAgentRunContext,
  createQueuedAgentLifecycle,
  dispatchExpertAgentHook,
} from "@expertmesh/agent-core";
import { randomUUID } from "node:crypto";

import { createMcpToolRegistry } from "../mcp-tools.ts";
import type { McpToolRegistry } from "../mcp-tools.ts";
import {
  collectRuntimeModelProviders,
  getRuntimeModelName,
  resolveRequiredRuntimeModel,
  writePiModelConfig,
} from "./models.ts";
import { createResourceLoader } from "./resources.ts";
import { createPiRuntimeSession } from "./session.ts";
import { createPiSessionManager } from "./session-manager.ts";
import { createResolvedPiTools } from "./tools.ts";
import type { CloudPiRuntimeAdapterOptions, PiRuntimeStreamState } from "./types.ts";
import { defaultOutputParser } from "./types.ts";

const CLOUD_PI_RUNTIME_DESCRIPTOR = {
  id: "cloud-pi-agent",
  kind: "cloud-pi-agent" as const,
  displayName: "Cloud PI Agent",
  capabilities: {
    executionLocations: ["cloud"],
    supportsAbort: true,
    supportsMcp: true,
    supportsStreaming: true,
    supportsSubAgents: true,
  },
};

export function createCloudPiRuntimeAdapter(
  options: CloudPiRuntimeAdapterOptions = {},
): RuntimeAdapter {
  return {
    descriptor: CLOUD_PI_RUNTIME_DESCRIPTOR,
    async createSession({
      agent,
      context: requestedRunContext,
      models,
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
        runtimeId: CLOUD_PI_RUNTIME_DESCRIPTOR.id,
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
        | ReturnType<typeof createQueuedAgentLifecycle<ExpertAgentRunContext>>
        | undefined;

      try {
        const authStorage = AuthStorage.create();
        const cwd = agent.workspace;
        logger.debug("Writing runtime model configuration", { cwd });
        const modelsJsonPath = await writePiModelConfig(
          cwd,
          agent.id,
          collectRuntimeModelProviders(agent, models),
        );
        const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath);
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
            await mcpToolRegistry?.dispose();
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
        });

        const sessionOptions: CreateAgentSessionOptions = {
          cwd,
          authStorage,
          modelRegistry,
          resourceLoader: loader,
          sessionManager: await createPiSessionManager(
            cwd,
            agent.id,
            runtimeSession,
            CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
          ),
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
        const sessionInfo = {
          systemSessionId,
          runtimeSession: {
            type: CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
            id: session.sessionId,
          },
          agentId: agent.id,
          runtime: CLOUD_PI_RUNTIME_DESCRIPTOR,
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
    | ReturnType<typeof createQueuedAgentLifecycle<ExpertAgentRunContext>>
    | undefined;
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
