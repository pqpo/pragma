import {
  createMcpToolRegistryPool,
  defineRuntimeDriver,
  registerExpertToolsMcpSession,
  type ExpertToolsMcpSessionRegistration,
  type ExpertToolRuntimeState,
  type McpToolRegistryLease,
  type RuntimeAdapter,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";

import { canUseAntigravityRuntime } from "./availability.ts";
import { resolveAntigravityExecutablePath } from "./executable.ts";
import { createManagedAntigravityIdentity, prepareManagedAntigravityHome } from "./managed-home.ts";
import { assertAntigravityModelSelection, createAntigravityModelDiscovery } from "./models.ts";
import { createAntigravityHookRelay, type AntigravityHookRelay } from "./permission-hooks.ts";
import {
  assertAntigravityConversationId,
  cancelAntigravityTurn,
  closeAntigravitySession,
  collectAntigravityUsage,
  consumeAntigravityStartupMessages,
  createAntigravityNativeSession,
  listAntigravityMessages,
  mapAntigravityEvent,
  startAntigravityTurn,
  type AntigravityNativeSession,
} from "./session.ts";
import type { AntigravityRuntimeAdapterOptions } from "./types.ts";
import { assertAntigravityWorkspaceCustomizationsAreIsolated } from "./workspace-customizations.ts";

const ANTIGRAVITY_DESCRIPTOR = {
  id: "antigravity",
  kind: "antigravity-local" as const,
  displayName: "Antigravity CLI",
  capabilities: {
    targets: ["agent"],
    executionLocations: ["local"],
    supportsAbort: true,
    supportsMcp: true,
    supportsModelDiscovery: true,
    supportsStreaming: true,
    supportsThinkingLevel: true,
    supportsContextCompactionEvents: true,
  },
};

interface AntigravityDriverSession extends AntigravityNativeSession {
  readonly mcpToolRegistryLease: McpToolRegistryLease;
  readonly expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration;
  readonly hookRelay: AntigravityHookRelay;
}

export function createAntigravityRuntime(
  options: AntigravityRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const mcpToolRegistries = options.mcpToolRegistryPool ?? createMcpToolRegistryPool();
  const descriptor = {
    ...ANTIGRAVITY_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? ANTIGRAVITY_DESCRIPTOR.kind,
    capabilities: {
      ...ANTIGRAVITY_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };
  const listModels = options.listModels ?? createAntigravityModelDiscovery(options);

  return defineRuntimeDriver(
    {
      descriptor,
      canUse: options.canUse ?? (() => canUseAntigravityRuntime(options)),
      listModels,
      outputRetryLimit: options.outputRetryLimit,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: ctx.paths.runtimeSessionDir("antigravity"),
          watch: true,
          checkpointOn: [
            "session.created",
            "runtimeSessionId.changed",
            "turn.completed",
            "context.compacted",
            "session.destroyed",
            "files.changed",
          ],
          metadata: { format: "antigravity-managed-session" },
        };
      },
      async createSession(ctx): Promise<AntigravityDriverSession> {
        await assertAntigravityWorkspaceCustomizationsAreIsolated(ctx.workspace);
        assertProvider(ctx.request.modelSelection?.model.providerId);
        const defaultModelName =
          ctx.request.modelSelection?.model.modelId ?? options.defaultModelName;
        const defaultThinkingLevel =
          ctx.request.modelSelection?.thinkingLevel ?? options.defaultThinkingLevel;
        if (defaultModelName !== undefined || defaultThinkingLevel !== undefined) {
          assertAntigravityModelSelection(
            await listModels(),
            defaultModelName,
            defaultThinkingLevel,
          );
        }
        const permissionMode = options.permissionMode ?? "request-approval";
        const sessionDir =
          ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("antigravity");
        const managedIdentity = createManagedAntigravityIdentity(ctx.agent.id, sessionDir);
        const restoredSessionId =
          ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "";
        const sessionId =
          restoredSessionId === "" ? "" : assertAntigravityConversationId(restoredSessionId);
        const toolRuntimeState: ExpertToolRuntimeState = {};
        let mcpToolRegistryLease: McpToolRegistryLease | undefined;
        let expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration | undefined;
        let hookRelay: AntigravityHookRelay | undefined;

        try {
          mcpToolRegistryLease = await mcpToolRegistries.acquire(ctx.agent.mcp);
          expertToolsMcpRegistration = await registerExpertToolsMcpSession({
            agent: ctx.agent,
            getContext: () => ctx.lifecycle.currentContext,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            logger: ctx.logger,
            mcpTools: mcpToolRegistryLease.registry.tools,
            state: toolRuntimeState,
            executionContext: ctx.request.executionContext,
          });
          hookRelay = await createAntigravityHookRelay({
            workspace: ctx.workspace,
            mcpServerName: managedIdentity.mcpServerName,
            permissionMode,
            getHumanInteractionHandler: () => ctx.request.humanInteractionHandler,
            toolRuntimeState,
          });
          const managedHome = await prepareManagedAntigravityHome({
            agent: ctx.agent,
            sessionDir,
            systemPrompt: ctx.agentContext.systemPrompt,
            mcpServerUrl: expertToolsMcpRegistration.url,
            hookRelay,
            permissionMode,
            authenticationMode: options.authenticationMode,
            processEnvironment: ctx.processEnvironment,
            nodeExecutablePath: options.hookNodeExecutablePath,
          });
          ctx.logger.info(
            "runtime.antigravity_session_ready",
            "Antigravity CLI Session preparation completed",
            {
              restoring: sessionId !== "",
              systemPromptCharacters: ctx.agentContext.systemPrompt.length,
              skillCount: managedHome.skills.length,
              toolCount: mcpToolRegistryLease.registry.tools.length,
              authenticationMode: managedHome.authenticationMode,
              mcpOpenedConnections: mcpToolRegistryLease.stats.openedConnections,
              mcpReusedConnections: mcpToolRegistryLease.stats.reusedConnections,
              mcpCoalescedConnections: mcpToolRegistryLease.stats.coalescedConnections,
            },
          );
          return {
            ...createAntigravityNativeSession({
              agent: ctx.agent,
              executablePath: resolveAntigravityExecutablePath(options),
              env: managedHome.env,
              logger: ctx.logger,
              managedHome,
              permissionMode,
              defaultModelName,
              defaultThinkingLevel,
              spawn: options.spawn,
              systemPrompt: ctx.agentContext.systemPrompt,
              toolRuntimeState,
              tokenCounter: options.tokenCounter,
              startupMessages: sessionId === "" ? ctx.agentContext.startupMessages : [],
              sessionId,
            }),
            mcpToolRegistryLease,
            expertToolsMcpRegistration,
            hookRelay,
          };
        } catch (error) {
          try {
            await disposeAntigravityResources(
              expertToolsMcpRegistration,
              mcpToolRegistryLease,
              hookRelay,
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              "Antigravity CLI Runtime initialization and cleanup failed.",
              { cause: cleanupError },
            );
          }
          throw error;
        }
      },
      readSession(session) {
        return {
          runtimeSessionId: session.sessionId,
          messages: session.messages,
        };
      },
      listMessages: listAntigravityMessages,
      consumeStartupMessages: consumeAntigravityStartupMessages,
      async startTurn(session, turn) {
        assertProvider(turn.modelSelection?.model.providerId);
        const modelName = turn.modelSelection?.model.modelId ?? session.defaultModelName;
        const thinkingLevel = turn.modelSelection?.thinkingLevel ?? session.defaultThinkingLevel;
        if (modelName !== undefined || thinkingLevel !== undefined) {
          assertAntigravityModelSelection(await listModels(), modelName, thinkingLevel);
        }
        return await startAntigravityTurn(session, turn);
      },
      mapEvent: mapAntigravityEvent,
      collectUsage(session, context) {
        return collectAntigravityUsage(session, context.outputText, context.usage);
      },
      cancelTurn: cancelAntigravityTurn,
      async closeSession(session) {
        const results = await Promise.allSettled([
          closeAntigravitySession(session),
          disposeAntigravityResources(
            session.expertToolsMcpRegistration,
            session.mcpToolRegistryLease,
            session.hookRelay,
          ),
        ]);
        const errors = results.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (errors.length > 0) {
          throw new AggregateError(errors, "Antigravity CLI Runtime cleanup failed.");
        }
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
      createProcessEnvironment: () => ({
        ...process.env,
        ...(options.env ?? {}),
      }),
    },
  );
}

function assertProvider(providerId: string | undefined): void {
  if (providerId !== undefined && providerId !== "antigravity") {
    throw new Error(
      `Antigravity CLI Runtime requires provider antigravity; received ${providerId}.`,
    );
  }
}

async function disposeAntigravityResources(
  registration: ExpertToolsMcpSessionRegistration | undefined,
  lease: McpToolRegistryLease | undefined,
  hookRelay: AntigravityHookRelay | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    Promise.resolve().then(async () => await registration?.dispose()),
    Promise.resolve().then(async () => await lease?.release()),
    Promise.resolve().then(async () => await hookRelay?.close()),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length > 0) {
    throw new AggregateError(errors, "Antigravity CLI Runtime resources could not be released.");
  }
}
