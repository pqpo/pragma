import { join } from "node:path";

import {
  createMcpToolRegistryPool,
  defineRuntimeFeatures,
  defineRuntimeDriver,
  registerExpertToolsMcpSession,
  runtimeFeature,
  type ExpertToolsMcpSessionRegistration,
  type ExpertToolRuntimeState,
  type McpToolRegistryLease,
  type RuntimeAdapter,
  type RuntimeFeatureSessionPrepareContext,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";

import { canUseAntigravityRuntime } from "./availability.ts";
import { resolveAntigravityExecutablePath } from "./executable.ts";
import {
  createManagedAntigravityIdentity,
  prepareManagedAntigravityHome,
  resolveAntigravityAuthenticationMode,
} from "./managed-home.ts";
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
  },
};

const ANTIGRAVITY_EVIDENCE_PENDING =
  "Implemented in the adapter; an executed Runtime probe evidence bundle is not recorded yet.";

interface AntigravityMcpPreparation {
  readonly mcpToolRegistryLease: McpToolRegistryLease;
  readonly expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration;
  readonly toolRuntimeState: ExpertToolRuntimeState;
  readonly permissionMode: NonNullable<AntigravityRuntimeAdapterOptions["permissionMode"]>;
  readonly sessionId: string;
  readonly sessionDir: string;
  readonly managedIdentity: ReturnType<typeof createManagedAntigravityIdentity>;
  readonly authenticationMode: ReturnType<typeof resolveAntigravityAuthenticationMode>;
  readonly customizationWorkspace?: string | undefined;
  readonly managedConfigDir: string;
}

interface AntigravityPermissionPreparation {
  readonly hookRelay: AntigravityHookRelay;
}

interface AntigravitySkillsPreparation {
  readonly managedHome: Awaited<ReturnType<typeof prepareManagedAntigravityHome>>;
}

type AntigravityDriverSession = AntigravityNativeSession;

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
  const prepareMcp = async (
    ctx: RuntimeFeatureSessionPrepareContext,
  ): Promise<AntigravityMcpPreparation> => {
    await assertAntigravityWorkspaceCustomizationsAreIsolated(ctx.workspace);
    const permissionMode = options.permissionMode ?? "request-approval";
    const sessionDir =
      ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("antigravity");
    const managedIdentity = createManagedAntigravityIdentity(ctx.agent.id, sessionDir);
    const authenticationMode = resolveAntigravityAuthenticationMode(
      options.authenticationMode ?? "isolated-environment",
      ctx.processEnvironment,
    );
    const customizationWorkspace =
      authenticationMode === "host-keyring"
        ? join(sessionDir, "managed-customizations")
        : undefined;
    const managedConfigDir =
      customizationWorkspace === undefined
        ? join(sessionDir, "home", ".gemini", "config")
        : join(customizationWorkspace, ".agents");
    const restoredSessionId =
      ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "";
    const sessionId =
      restoredSessionId === "" ? "" : assertAntigravityConversationId(restoredSessionId);
    const toolRuntimeState: ExpertToolRuntimeState = {};
    const mcpToolRegistryLease = await ctx.resources.acquire(
      "antigravity.mcp-registry",
      async () => await mcpToolRegistries.acquire(ctx.agent.mcp),
      async (lease) => await lease.release(),
    );
    const expertToolsMcpRegistration = await ctx.resources.acquire(
      "antigravity.mcp-registration",
      async () =>
        await registerExpertToolsMcpSession({
          agent: ctx.agent,
          getContext: () => ctx.lifecycle.currentContext,
          humanInteractionHandler: ctx.request.humanInteractionHandler,
          logger: ctx.logger,
          mcpTools: mcpToolRegistryLease.registry.tools,
          state: toolRuntimeState,
          executionContext: ctx.request.executionContext,
        }),
      async (registration) => await registration.dispose(),
    );
    return {
      mcpToolRegistryLease,
      expertToolsMcpRegistration,
      toolRuntimeState,
      permissionMode,
      sessionId,
      sessionDir,
      managedIdentity,
      authenticationMode,
      ...(customizationWorkspace === undefined ? {} : { customizationWorkspace }),
      managedConfigDir,
    };
  };
  const preparePermissions = async (
    ctx: RuntimeFeatureSessionPrepareContext,
    { mcp }: { readonly mcp: AntigravityMcpPreparation },
  ): Promise<AntigravityPermissionPreparation> => {
    const hookRelay = await ctx.resources.acquire(
      "antigravity.permission-relay",
      async () =>
        await createAntigravityHookRelay({
          workspace: ctx.workspace,
          allowedWorkspacePaths: [
            ctx.workspace,
            ...(mcp.customizationWorkspace === undefined ? [] : [mcp.customizationWorkspace]),
          ],
          managedSkillReadRoots: [
            join(
              mcp.managedConfigDir,
              "plugins",
              `pragma-${mcp.managedIdentity.namespace}`,
              "skills",
            ),
          ],
          mcpServerName: mcp.managedIdentity.mcpServerName,
          permissionMode: mcp.permissionMode,
          getHumanInteractionHandler: () => ctx.request.humanInteractionHandler,
          toolRuntimeState: mcp.toolRuntimeState,
          onDecision(event) {
            ctx.logger.debug(
              "runtime.antigravity_hook_decision",
              "Antigravity PreToolUse hook decision completed",
              event,
            );
          },
        }),
      async (relay) => await relay.close(),
    );
    return { hookRelay };
  };
  const prepareSkills = async (
    ctx: RuntimeFeatureSessionPrepareContext,
    {
      mcp,
      permissions,
    }: {
      readonly mcp: AntigravityMcpPreparation;
      readonly permissions: AntigravityPermissionPreparation;
    },
  ): Promise<AntigravitySkillsPreparation> => {
    return {
      managedHome: await prepareManagedAntigravityHome({
        agent: ctx.agent,
        sessionDir: mcp.sessionDir,
        systemPrompt: ctx.agentContext.systemPrompt,
        mcpServerUrl: mcp.expertToolsMcpRegistration.url,
        hookRelay: permissions.hookRelay,
        permissionMode: mcp.permissionMode,
        authenticationMode: mcp.authenticationMode,
        processEnvironment: ctx.processEnvironment,
        nodeExecutablePath: options.hookNodeExecutablePath,
      }),
    };
  };
  const implemented = () =>
    runtimeFeature.native(runtimeFeature.degraded(ANTIGRAVITY_EVIDENCE_PENDING));
  const mcp = runtimeFeature.session({
    readiness: runtimeFeature.degraded(ANTIGRAVITY_EVIDENCE_PENDING),
    prepare: prepareMcp,
  });
  const permissions = runtimeFeature.session({
    readiness: runtimeFeature.degraded(ANTIGRAVITY_EVIDENCE_PENDING),
    needs: { mcp },
    prepare: preparePermissions,
  });
  const skills = runtimeFeature.session({
    readiness: runtimeFeature.degraded(ANTIGRAVITY_EVIDENCE_PENDING),
    needs: { mcp, permissions },
    prepare: prepareSkills,
  });
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
    mcp,
    permissions,
    userInteraction: implemented(),
    skills,
    attachmentImage: runtimeFeature.native(
      runtimeFeature.degraded(
        "The CLI receives image paths through prompt context because agy has no stable native image flag.",
      ),
    ),
    attachmentFile: implemented(),
    attachmentDirectory: implemented(),
    usage: implemented(),
    contextWindow: runtimeFeature.native(
      runtimeFeature.unsupported("agy does not expose a stable context-window inspection endpoint."),
    ),
    compaction: runtimeFeature.native(
      runtimeFeature.degraded(ANTIGRAVITY_EVIDENCE_PENDING, { compactionModes: ["events"] }),
    ),
    cancellation: implemented(),
    steering: runtimeFeature.native(
      runtimeFeature.unsupported("agy exposes no safe active-turn steering API."),
    ),
    close: implemented(),
    cleanup: implemented(),
  });

  return defineRuntimeDriver(
    {
      descriptor,
      features,
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
        const mcp = ctx.features.mcp;
        const skills = ctx.features.skills;
        const { managedHome } = skills;
        ctx.logger.info(
          "runtime.antigravity_session_ready",
          "Antigravity CLI Session preparation completed",
          {
            restoring: mcp.sessionId !== "",
            systemPromptCharacters: ctx.agentContext.systemPrompt.length,
            skillCount: managedHome.skills.length,
            toolCount: mcp.mcpToolRegistryLease.registry.tools.length,
            authenticationMode: managedHome.authenticationMode,
            mcpOpenedConnections: mcp.mcpToolRegistryLease.stats.openedConnections,
            mcpReusedConnections: mcp.mcpToolRegistryLease.stats.reusedConnections,
            mcpCoalescedConnections: mcp.mcpToolRegistryLease.stats.coalescedConnections,
          },
        );
        return createAntigravityNativeSession({
          agent: ctx.agent,
          executablePath: resolveAntigravityExecutablePath(options),
          env: managedHome.env,
          logger: ctx.logger,
          managedHome,
          permissionMode: mcp.permissionMode,
          defaultModelName,
          defaultThinkingLevel,
          spawn: options.spawn,
          systemPrompt: ctx.agentContext.systemPrompt,
          toolRuntimeState: mcp.toolRuntimeState,
          tokenCounter: options.tokenCounter,
          startupMessages: mcp.sessionId === "" ? ctx.agentContext.startupMessages : [],
          sessionId: mcp.sessionId,
        });
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
        await closeAntigravitySession(session);
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
