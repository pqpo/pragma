import { AuthStorage, createAgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { ExpertAgentRunContext, RuntimeAdapter } from "@expertmesh/agent-core";
import { createQueuedAgentLifecycle, dispatchExpertAgentHook } from "@expertmesh/agent-core";
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
      let piSession: AgentSession | undefined;
      let mcpToolRegistry: McpToolRegistry | undefined;
      let lifecycle: ReturnType<typeof createQueuedAgentLifecycle<ExpertAgentRunContext>> | undefined;

      try {
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
        mcpToolRegistry = await createMcpToolRegistry(agent.mcp);
        const streamState: PiRuntimeStreamState = {};
        lifecycle = createQueuedAgentLifecycle<ExpertAgentRunContext>(runContext, {
          abort: async () => {
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
            });
            piSession?.dispose();
            await mcpToolRegistry?.dispose();
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
