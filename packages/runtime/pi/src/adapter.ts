import {
  SettingsManager,
  createAgentSession,
  createBashToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  BashToolInput,
  CreateAgentSessionOptions,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  PragmaLogger,
  ResolvedModelProvider,
  RuntimeAdapter,
  RuntimeModelRef,
  RuntimeTokenModelIdentity,
} from "@pragma/core";
import {
  createMcpToolRegistryPool,
  defineRuntimeFeatures,
  defineRuntimeDriver,
  runtimeFeature,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";

import {
  createPiModelRuntime,
  createPiModelProviderConverter,
  normalizePiRuntimeModels,
  registerPiModelProvider,
  resolvePiThinkingLevel,
  resolveRequiredRuntimeModel,
} from "./models.ts";
import { createResourceLoader } from "./resources.ts";
import { createPiSessionManager } from "./session-manager.ts";
import {
  canCompactPiContextWindow,
  compactPiContextWindow,
  collectPiUsage,
  consumePiStartupMessages,
  createPiNativeSession,
  listPiMessages,
  mapPiAgentEvent,
  readPiContextWindow,
  setPiTokenModelIdentity,
  startPiTurn,
  type PiNativeSession,
} from "./session.ts";
import { createResolvedPiTools } from "./tools.ts";
import type { CloudPiRuntimeAdapterOptions, PiRuntimeStreamState } from "./types.ts";
import { defaultOutputParser } from "./types.ts";

const CLOUD_PI_RUNTIME_DESCRIPTOR = {
  id: "cloud-pi-agent",
  kind: "cloud-pi-agent" as const,
  displayName: "Built-in Runtime",
  capabilities: {
    targets: ["agent"],
    executionLocations: ["cloud"],
  },
};

const PI_EVIDENCE_PENDING =
  "Implemented in the adapter; an executed Runtime probe evidence bundle is not recorded yet.";

type PiDriverSession = PiNativeSession;

export function createPiRuntime(options: CloudPiRuntimeAdapterOptions = {}): RuntimeAdapter {
  const modelProviderConverter = createPiModelProviderConverter();
  const mcpToolRegistries = options.mcpToolRegistryPool ?? createMcpToolRegistryPool();
  const descriptor = {
    ...CLOUD_PI_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CLOUD_PI_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CLOUD_PI_RUNTIME_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };
  const implemented = () => runtimeFeature.degraded(PI_EVIDENCE_PENDING);
  const features = defineRuntimeFeatures({
    availability: implemented(),
    authentication: implemented(),
    modelDiscovery: implemented(),
    modelSelection: implemented(),
    thinking: implemented(),
    freshSession: implemented(),
    resume: implemented(),
    systemPrompt: implemented(),
    startupMessages: implemented(),
    textStreaming: implemented(),
    reasoningStreaming: implemented(),
    nativeToolLifecycle: implemented(),
    mcp: implemented(),
    permissions: implemented(),
    userInteraction: implemented(),
    skills: implemented(),
    attachmentImage: implemented(),
    attachmentFile: implemented(),
    attachmentDirectory: implemented(),
    usage: implemented(),
    contextWindow: implemented(),
    compaction: runtimeFeature.degraded(PI_EVIDENCE_PENDING, {
      compactionModes: ["manual", "events"],
    }),
    cancellation: implemented(),
    steering: implemented(),
    close: implemented(),
    cleanup: implemented(),
  });

  return defineRuntimeDriver(
    {
      descriptor,
      features,
      canUse: () => ({
        usable: true,
        details: { executionMode: "in-process" },
      }),
      listModels: async () =>
        normalizePiRuntimeModels(
          (await options.modelProviders?.listProviders())?.flatMap((provider) =>
            modelProviderConverter.toRuntimeModels(provider),
          ) ?? [],
        ),
      defaultOutputParser: options.outputParser ?? defaultOutputParser,
      outputRetryLimit: options.outputRetryLimit ?? 3,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: ctx.paths.runtimeSessionDir("pi"),
          watch: true,
          debounceMs: options.sessionSyncDebounceMs,
          checkpointOn: [
            "session.created",
            "turn.completed",
            "context.compacted",
            "session.destroyed",
            "files.changed",
          ],
          metadata: {
            format: "pi-agent-session-dir",
          },
        };
      },
      async createSession(ctx): Promise<PiDriverSession> {
        const sessionStartedAt = performance.now();
        const selectedModel = ctx.request.modelSelection?.model;
        const selectedProviderId = selectedModel?.providerId;
        const cwd = ctx.workspace;
        const settingsManager = SettingsManager.create(cwd);
        const compactionKeepRecentTokens = settingsManager.getCompactionKeepRecentTokens();
        settingsManager.applyOverrides({
          compaction: {
            enabled: true,
          },
        });
        const loader = createResourceLoader(ctx.agent, cwd, ctx.agentContext.systemPrompt);
        const resourceReloadPromise = timedPiPhase(
          ctx.logger,
          "resource_loader_reload",
          sessionStartedAt,
          async () => await loader.reload(),
        );
        const [registeredProvider, , mcpToolRegistryLease, piSessionManagerResult] =
          await Promise.all([
            selectedProviderId === undefined
              ? Promise.resolve(undefined)
              : timedPiPhase(ctx.logger, "model_provider_resolve", sessionStartedAt, async () =>
                  options.modelProviders?.resolveProvider(selectedProviderId),
                ),
            resourceReloadPromise,
            timedPiPhase(
              ctx.logger,
              "mcp_tool_registry",
              sessionStartedAt,
              async () =>
                await ctx.resources.acquire(
                  "pi.mcp-registry",
                  async () => await mcpToolRegistries.acquire(ctx.agent.mcp),
                  async (lease) => await lease.release(),
                ),
            ),
            timedPiPhase(
              ctx.logger,
              "session_manager",
              sessionStartedAt,
              async () =>
                await createPiSessionManager(
                  cwd,
                  ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("pi"),
                  ctx.request.runtimeSession?.id,
                ),
            ),
          ]);
        if (selectedProviderId !== undefined && registeredProvider === undefined) {
          throw new Error(`Model provider is not registered: ${selectedProviderId}`);
        }
        const modelRuntimeResult = await timedPiPhase(
          ctx.logger,
          "model_runtime",
          sessionStartedAt,
          async () =>
            await createPiModelRuntime(
              registeredProvider === undefined
                ? []
                : [modelProviderConverter.convertProvider(registeredProvider)],
            ),
        );
        let session: AgentSession | undefined;
        try {
          const { modelRegistry, modelRuntime } = modelRuntimeResult;
          const streamState: PiRuntimeStreamState = { logger: ctx.logger };
          const toolsStartedAt = performance.now();
          const resolvedTools = createResolvedPiTools({
            agent: ctx.agent,
            cwd,
            mcpTools: mcpToolRegistryLease.registry.tools,
            parentSystemPrompt: ctx.agentContext.systemPrompt,
            streamState,
            lifecycle: ctx.lifecycle,
            context: ctx.runContext,
            executionContext: ctx.request.executionContext,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
          });
          logPiPhase(ctx.logger, "tool_schema_build", toolsStartedAt, sessionStartedAt, {
            toolCount: resolvedTools.tools.length,
            systemPromptCharacters: ctx.agentContext.systemPrompt.length,
          });
          const sessionOptions: CreateAgentSessionOptions = {
            cwd,
            modelRuntime,
            resourceLoader: loader,
            sessionManager: piSessionManagerResult.sessionManager,
            settingsManager,
          };
          const defaultModel = resolveRequiredRuntimeModel(
            selectedModel,
            modelRegistry,
            "agent default",
          );

          if (defaultModel !== undefined) {
            sessionOptions.model = defaultModel;
          }
          const defaultThinkingLevel = resolvePiThinkingLevel(
            ctx.request.modelSelection?.thinkingLevel,
          );
          if (defaultThinkingLevel !== undefined) {
            sessionOptions.thinkingLevel = defaultThinkingLevel;
          }

          sessionOptions.customTools = [
            ...resolvedTools.tools.map((tool) => tool.tool),
            createPiSessionBashTool({
              cwd,
              processEnvironment: ctx.processEnvironment,
              commandPrefix: settingsManager.getShellCommandPrefix(),
              shellPath: settingsManager.getShellPath(),
            }),
          ];

          ({ session } = await timedPiPhase(
            ctx.logger,
            "agent_session_create",
            sessionStartedAt,
            async () => await createAgentSession(sessionOptions),
          ));
          ctx.logger.info("runtime.pi_session_ready", "Runtime session preparation completed", {
            elapsedMs: piElapsedMs(sessionStartedAt),
            toolCount: sessionOptions.customTools?.length ?? 0,
            systemPromptCharacters: ctx.agentContext.systemPrompt.length,
            mcpOpenedConnections: mcpToolRegistryLease.stats.openedConnections,
            mcpReusedConnections: mcpToolRegistryLease.stats.reusedConnections,
            mcpCoalescedConnections: mcpToolRegistryLease.stats.coalescedConnections,
          });

          return createPiNativeSession({
            agent: ctx.agent,
            session,
            streamState,
            models: {
              defaultModel: selectedModel,
              modelRegistry,
              modelRuntime,
            },
            compactionKeepRecentTokens,
            startupMessages: piSessionManagerResult.resumedExistingSession
              ? []
              : ctx.agentContext.startupMessages,
            tokenCounter: options.tokenCounter,
            tokenModelIdentity: piTokenModelIdentity(registeredProvider, selectedModel),
          });
        } catch (error) {
          session?.dispose();
          throw error;
        }
      },
      readSession(session) {
        return {
          runtimeSessionId: session.session.sessionId,
        };
      },
      listMessages: listPiMessages,
      consumeStartupMessages: consumePiStartupMessages,
      async startTurn(session, turn) {
        const selectedModel = turn.modelSelection?.model;
        if (selectedModel !== undefined) {
          const provider = await options.modelProviders?.resolveProvider(selectedModel.providerId);
          if (provider === undefined) {
            throw new Error(`Model provider is not registered: ${selectedModel.providerId}`);
          }
          setPiTokenModelIdentity(session, piTokenModelIdentity(provider, selectedModel));
          registerPiModelProvider(
            session.models.modelRuntime,
            modelProviderConverter.convertProvider(provider),
          );
        }
        return await startPiTurn(session, turn);
      },
      mapEvent: mapPiAgentEvent,
      collectUsage(session) {
        return collectPiUsage(session);
      },
      readContextWindow: readPiContextWindow,
      canCompactContext: canCompactPiContextWindow,
      compactContext: compactPiContextWindow,
      async cancelTurn(session) {
        await session.session.abort();
      },
      async steerTurn(session, request) {
        await session.session.steer(request.content);
      },
      async closeSession(session) {
        session.session.dispose();
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
    },
  );
}

function piTokenModelIdentity(
  provider: ResolvedModelProvider | undefined,
  model: RuntimeModelRef | undefined,
): RuntimeTokenModelIdentity {
  const providerModel = provider?.models.find((candidate) => candidate.id === model?.modelId);
  return {
    runtimeKind: "cloud-pi-agent",
    ...(provider === undefined ? {} : { providerCatalogId: provider.catalogId }),
    ...(model === undefined ? {} : { providerId: model.providerId, modelId: model.modelId }),
    ...(providerModel?.api === undefined && provider?.api === undefined
      ? {}
      : { api: providerModel?.api ?? provider?.api }),
  };
}

async function timedPiPhase<T>(
  logger: Pick<PragmaLogger, "info">,
  phase: string,
  sessionStartedAt: number,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const value = await operation();
  logPiPhase(logger, phase, startedAt, sessionStartedAt);
  return value;
}

function logPiPhase(
  logger: Pick<PragmaLogger, "info">,
  phase: string,
  phaseStartedAt: number,
  sessionStartedAt: number,
  attributes: Record<string, unknown> = {},
): void {
  logger.info("runtime.pi_prepare_phase", `Runtime preparation phase completed: ${phase}`, {
    phase,
    durationMs: piElapsedMs(phaseStartedAt),
    elapsedMs: piElapsedMs(sessionStartedAt),
    ...attributes,
  });
}

function piElapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

export function createPiSessionBashTool(options: {
  readonly cwd: string;
  readonly processEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly commandPrefix?: string | undefined;
  readonly shellPath?: string | undefined;
}): ToolDefinition {
  const tool = createBashToolDefinition(options.cwd, {
    ...(options.commandPrefix === undefined ? {} : { commandPrefix: options.commandPrefix }),
    ...(options.shellPath === undefined ? {} : { shellPath: options.shellPath }),
    spawnHook: (context) => ({
      ...context,
      env: { ...options.processEnvironment },
    }),
  });
  return {
    name: tool.name,
    label: tool.label,
    description: tool.description,
    ...(tool.promptSnippet === undefined ? {} : { promptSnippet: tool.promptSnippet }),
    parameters: tool.parameters,
    ...(tool.executionMode === undefined ? {} : { executionMode: tool.executionMode }),
    async execute(toolCallId, params, signal, onUpdate, context) {
      return await tool.execute(
        toolCallId,
        params as BashToolInput,
        signal,
        onUpdate as Parameters<typeof tool.execute>[3],
        context as Parameters<typeof tool.execute>[4],
      );
    },
  };
}
