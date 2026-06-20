import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import type { ExpertAgentRunContext, RuntimeAdapter } from "@expertmesh/agent-core";
import { createQueuedAgentLifecycle } from "@expertmesh/agent-core";

import { createMcpToolRegistry } from "../mcp-tools.ts";
import { createResourceLoader } from "./resources.ts";
import { createPiRuntimeSession } from "./session.ts";
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
    async createSession({ agent, context: runContext }) {
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const cwd = agent.workspace;
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
          piSession?.dispose();
          await mcpToolRegistry.dispose();
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
        sessionManager: SessionManager.inMemory(),
      };

      if (customTools.length > 0) {
        sessionOptions.customTools = customTools;
      }

      try {
        const { session } = await createAgentSession(sessionOptions);
        piSession = session;

        return createPiRuntimeSession<TOutput>(
          session,
          {
            sessionId: session.sessionId,
            agentId: agent.id,
            runtime: {
              id: "cloud-pi-agent",
              kind: "cloud-pi-agent",
              displayName: "Cloud PI Agent",
            },
          },
          options.outputParser ?? defaultOutputParser,
          lifecycle,
          streamBridge,
        );
      } catch (error) {
        await mcpToolRegistry.dispose();
        throw error;
      }
    },
  };
}
