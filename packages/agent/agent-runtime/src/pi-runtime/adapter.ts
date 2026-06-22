import { AuthStorage, createAgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ExpertAgentRunContext, RuntimeAdapter } from "@expertmesh/agent-core";
import { createQueuedAgentLifecycle, dispatchExpertAgentHook } from "@expertmesh/agent-core";
import { randomUUID } from "node:crypto";

import { createMcpToolRegistry } from "../mcp-tools.ts";
import {
  collectRuntimeModelProviders,
  getRuntimeModelName,
  resolveRequiredRuntimeModel,
  writePiModelConfig,
} from "./models.ts";
import { createResourceLoader } from "./resources.ts";
import { createPiRuntimeSession } from "./session.ts";
import { createPiSessionManager } from "./session-manager.ts";
import { createRuntimeStreamBridge } from "./stream.ts";
import { createResolvedPiTools } from "./tools.ts";
import type { CloudPiRuntimeAdapterOptions } from "./types.ts";
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
      context: runContext,
      models,
      runtimeSession,
      systemSessionId: requestedSystemSessionId,
    }) {
      const systemSessionId = requestedSystemSessionId ?? randomUUID();
      await dispatchExpertAgentHook(agent.hooks, "beforeSessionCreate", {
        agent,
        context: runContext,
        systemSessionId,
        runtimeSession,
      });
      const authStorage = AuthStorage.create();
      const cwd = agent.workspace;
      const modelsJsonPath = await writePiModelConfig(
        cwd,
        agent.id,
        collectRuntimeModelProviders(agent, models),
      );
      const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath);
      const context = await agent.buildContext(runContext);
      const loader = createResourceLoader(agent, cwd, context.systemPrompt);
      await loader.reload();
      const mcpToolRegistry = await createMcpToolRegistry(agent.mcp);
      let piSession: AgentSession | undefined;
      const streamBridge = createRuntimeStreamBridge();
      const lifecycle = createQueuedAgentLifecycle<ExpertAgentRunContext>(runContext, {
        abort: async () => {
          await piSession?.abort();
        },
        cleanup: async () => {
          const sessionInfo = {
            systemSessionId,
            runtimeSession: {
              type: CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
              id:
                piSession?.sessionId ??
                (runtimeSession?.type === CLOUD_PI_RUNTIME_DESCRIPTOR.kind
                  ? runtimeSession.id
                  : ""),
            },
            agentId: agent.id,
            runtime: CLOUD_PI_RUNTIME_DESCRIPTOR,
            sessionState: lifecycle.sessionState,
            runState: lifecycle.runState,
          };
          await dispatchExpertAgentHook(agent.hooks, "beforeSessionDestroy", {
            agent,
            session: sessionInfo,
          });
          piSession?.dispose();
          await mcpToolRegistry.dispose();
          await dispatchExpertAgentHook(agent.hooks, "afterSessionDestroy", {
            agent,
            session: sessionInfo,
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
        streamBridge,
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

      try {
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
        });

        return createPiRuntimeSession(
          agent,
          session,
          sessionInfo,
          options.outputParser ?? defaultOutputParser,
          lifecycle,
          streamBridge,
          {
            defaultModelName: agent.models?.defaultModelName,
            modelRegistry,
          },
          {
            outputRetryLimit: options.outputRetryLimit,
          },
        );
      } catch (error) {
        await mcpToolRegistry.dispose();
        throw error;
      }
    },
  };
}
