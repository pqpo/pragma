import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { ExpertAgentRunContext, RuntimeAdapter } from "@expertmesh/agent-core";
import { createQueuedAgentLifecycle, dispatchExpertAgentHook } from "@expertmesh/agent-core";

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
import { createCustomTools } from "./tools.ts";
import type { CloudPiRuntimeAdapterOptions } from "./types.ts";
import { defaultOutputParser } from "./types.ts";

export function createCloudPiRuntimeAdapter<TOutput = string>(
  options: CloudPiRuntimeAdapterOptions = {},
): RuntimeAdapter<TOutput> {
  return {
    descriptor: {
      id: "cloud-pi-agent",
      kind: "cloud-pi-agent",
      displayName: "Cloud PI Agent",
    },
    async createSession({ agent, context: runContext, models, sessionId }) {
      await dispatchExpertAgentHook(agent.hooks, "beforeSessionCreate", {
        agent,
        context: runContext,
        sessionId,
      });
      const authStorage = AuthStorage.create();
      const cwd = agent.workspace;
      const modelsJsonPath = await writePiModelConfig(
        cwd,
        agent.id,
        collectRuntimeModelProviders(agent, models),
      );
      const modelRegistry = ModelRegistry.create(authStorage, modelsJsonPath);
      const context = await agent.buildContext();
      const loader = createResourceLoader(agent, cwd, context.systemPrompt);
      await loader.reload();
      const mcpToolRegistry = await createMcpToolRegistry(agent.mcp);
      let piSession: AgentSession | undefined;
      const streamBridge = createRuntimeStreamBridge();
      const lifecycle = createQueuedAgentLifecycle<ExpertAgentRunContext>(runContext, {
        abort: () => {
          void piSession?.abort();
        },
        cleanup: async () => {
          const sessionInfo = {
            sessionId: piSession?.sessionId ?? sessionId ?? "",
            agentId: agent.id,
            runtime: {
              id: "cloud-pi-agent",
              kind: "cloud-pi-agent" as const,
              displayName: "Cloud PI Agent",
            },
            state: lifecycle.state,
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
      const customTools = createCustomTools({
        agent,
        authStorage,
        cwd,
        mcpTools: mcpToolRegistry.tools,
        modelRegistry,
        parentSystemPrompt: context.systemPrompt,
        streamBridge,
        lifecycle,
      });

      const sessionOptions: CreateAgentSessionOptions = {
        cwd,
        authStorage,
        modelRegistry,
        resourceLoader: loader,
        sessionManager: await createPiSessionManager(cwd, agent.id, sessionId),
      };
      const defaultModel = resolveRequiredRuntimeModel(
        getRuntimeModelName(agent, undefined),
        modelRegistry,
        "agent default",
      );

      if (defaultModel !== undefined) {
        sessionOptions.model = defaultModel;
      }

      if (customTools.length > 0) {
        sessionOptions.customTools = customTools;
      }

      try {
        const { session } = await createAgentSession(sessionOptions);
        piSession = session;
        const sessionInfo = {
          sessionId: session.sessionId,
          agentId: agent.id,
          runtime: {
            id: "cloud-pi-agent",
            kind: "cloud-pi-agent" as const,
            displayName: "Cloud PI Agent",
          },
        };

        await dispatchExpertAgentHook(agent.hooks, "afterSessionCreate", {
          agent,
          session: {
            ...sessionInfo,
            state: lifecycle.state,
          },
        });

        return createPiRuntimeSession<TOutput>(
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
        );
      } catch (error) {
        await mcpToolRegistry.dispose();
        throw error;
      }
    },
  };
}
