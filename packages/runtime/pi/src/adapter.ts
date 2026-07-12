import { AuthStorage, createAgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentSession, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { McpToolRegistry, RuntimeAdapter } from "@pragma/core";
import {
  createMcpToolRegistry,
  defineRuntimeDriver,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";

import {
  collectRuntimeModelProviders,
  createPiModelRegistry,
  getRuntimeModelName,
  resolveRequiredRuntimeModel,
} from "./models.ts";
import { createResourceLoader } from "./resources.ts";
import { createPiSessionManager } from "./session-manager.ts";
import {
  collectPiUsage,
  createPiNativeSession,
  listPiMessages,
  mapPiAgentEvent,
  startPiTurn,
  type PiNativeSession,
} from "./session.ts";
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

interface PiDriverSession extends PiNativeSession {
  readonly mcpToolRegistry: McpToolRegistry;
}

export function createPiRuntime(options: CloudPiRuntimeAdapterOptions = {}): RuntimeAdapter {
  const descriptor = {
    ...CLOUD_PI_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CLOUD_PI_RUNTIME_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };

  return defineRuntimeDriver(
    {
      descriptor,
      defaultOutputParser: options.outputParser ?? defaultOutputParser,
      outputRetryLimit: options.outputRetryLimit ?? 3,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: ctx.paths.runtimeSessionDir("pi"),
          watch: true,
          debounceMs: options.sessionSyncDebounceMs,
          checkpointOn: ["session.created", "turn.completed", "session.destroyed", "files.changed"],
          metadata: {
            format: "pi-agent-session-dir",
          },
        };
      },
      async createSession(ctx): Promise<PiDriverSession> {
        const authStorage = AuthStorage.create();
        const cwd = ctx.workspace;
        const modelRegistry = createPiModelRegistry(
          authStorage,
          collectRuntimeModelProviders(ctx.agent, ctx.request.models),
        );
        const loader = createResourceLoader(ctx.agent, cwd, ctx.agentContext.systemPrompt);
        await loader.reload();
        const mcpToolRegistry = await createMcpToolRegistry(ctx.agent.mcp);
        const streamState: PiRuntimeStreamState = { logger: ctx.logger };
        const resolvedTools = createResolvedPiTools({
          agent: ctx.agent,
          authStorage,
          cwd,
          mcpTools: mcpToolRegistry.tools,
          modelRegistry,
          parentSystemPrompt: ctx.agentContext.systemPrompt,
          streamState,
          lifecycle: ctx.lifecycle,
          context: ctx.runContext,
          workflowExecution: ctx.request.workflowExecution,
          humanInteractionHandler: ctx.request.humanInteractionHandler,
        });
        const piSessionManagerResult = await createPiSessionManager(
          cwd,
          ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("pi"),
          ctx.request.runtimeSession?.id,
        );
        const sessionOptions: CreateAgentSessionOptions = {
          cwd,
          authStorage,
          modelRegistry,
          resourceLoader: loader,
          sessionManager: piSessionManagerResult.sessionManager,
        };
        const defaultModel = resolveRequiredRuntimeModel(
          getRuntimeModelName(ctx.agent, undefined),
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
        if (!piSessionManagerResult.resumedExistingSession) {
          appendStartupMessages(session, ctx.agentContext.startupMessages);
        }

        return {
          ...createPiNativeSession({
            agent: ctx.agent,
            session,
            streamState,
            models: {
              defaultModelName: ctx.agent.models?.defaultModelName,
              modelRegistry,
            },
          }),
          mcpToolRegistry,
        };
      },
      readSession(session) {
        return {
          runtimeSessionId: session.session.sessionId,
        };
      },
      listMessages: listPiMessages,
      startTurn: startPiTurn,
      mapEvent: mapPiAgentEvent,
      collectUsage(session) {
        return collectPiUsage(session);
      },
      async cancelTurn(session) {
        await session.session.abort();
      },
      async destroySession(session) {
        session.session.dispose();
        await session.mcpToolRegistry.dispose();
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
    },
  );
}

function appendStartupMessages(
  session: AgentSession,
  messages: readonly { readonly role: "user"; readonly content: string }[],
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
