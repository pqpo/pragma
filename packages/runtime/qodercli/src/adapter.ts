import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createMcpToolRegistryPool,
  defaultRuntimeTokenCounter,
  defineRuntimeDriver,
  registerExpertToolsMcpSession,
  type ExpertToolsMcpSessionRegistration,
  type ExpertToolRuntimeState,
  type McpToolRegistry,
  type McpToolRegistryLease,
  type PragmaLogger,
  type RuntimeAdapter,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";

import { canUseQoderCliRuntime } from "./availability.ts";
import { resolveQoderCliExecutablePath } from "./executable.ts";
import { createQoderCliModelDiscovery } from "./models.ts";
import { prepareManagedQoderConfig } from "./qoder-config.ts";
import { resolveQoderAuth } from "./sdk-options.ts";
import {
  cancelQoderTurn,
  closeQoderSession,
  compactQoderContextWindow,
  listQoderMessages,
  mapQoderEvent,
  readQoderContextWindow,
  startQoderTurn,
  type QoderNativeSession,
} from "./session.ts";
import { materializeQoderSkillPlugin } from "./skills.ts";
import type { QoderCliRuntimeAdapterOptions } from "./types.ts";

const QODER_DESCRIPTOR = {
  id: "qodercli-local",
  kind: "qodercli-local" as const,
  displayName: "Qoder CLI Local",
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

interface QoderDriverSession extends QoderNativeSession {
  readonly mcpToolRegistry: McpToolRegistry;
  readonly mcpToolRegistryLease: McpToolRegistryLease;
  readonly expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration;
}

export function createQoderCliRuntime(options: QoderCliRuntimeAdapterOptions = {}): RuntimeAdapter {
  const mcpToolRegistries = createMcpToolRegistryPool();
  const descriptor = {
    ...QODER_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? QODER_DESCRIPTOR.kind,
    capabilities: {
      ...QODER_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };
  const listModels = options.listModels ?? createQoderCliModelDiscovery(options);

  return defineRuntimeDriver(
    {
      descriptor,
      canUse: options.canUse ?? (() => canUseQoderCliRuntime(options)),
      listModels,
      outputRetryLimit: options.outputRetryLimit,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: ctx.paths.runtimeSessionDir("qodercli"),
          checkpointOn: [
            "session.created",
            "runtimeSessionId.changed",
            "turn.completed",
            "context.compacted",
            "session.destroyed",
          ],
          metadata: { format: "qodercli-managed-config" },
        };
      },
      async createSession(ctx): Promise<QoderDriverSession> {
        const sessionStartedAt = performance.now();
        assertProvider(ctx.request.modelSelection?.model.providerId);
        const sessionDir =
          ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("qodercli");
        const configPromise = timedQoderPhase(
          ctx.logger,
          "prepare_managed_config",
          sessionStartedAt,
          async () =>
            await prepareManagedQoderConfig({
              sessionDir,
              env: ctx.processEnvironment,
              logger: ctx.logger,
            }),
        );
        const pluginPromise = timedQoderPhase(
          ctx.logger,
          "skill_plugin_materialization",
          sessionStartedAt,
          async () => await materializeQoderSkillPlugin(ctx.agent, sessionDir),
        );
        const registryLeasePromise = timedQoderPhase(
          ctx.logger,
          "mcp_tool_registry",
          sessionStartedAt,
          async () => await mcpToolRegistries.acquire(ctx.agent.mcp),
        );
        let configDir: string;
        let plugin: Awaited<ReturnType<typeof materializeQoderSkillPlugin>>;
        let mcpToolRegistry: McpToolRegistry | undefined;
        let mcpToolRegistryLease: McpToolRegistryLease | undefined;
        try {
          const prepared = await Promise.all([configPromise, pluginPromise, registryLeasePromise]);
          [configDir, plugin, mcpToolRegistryLease] = prepared;
          mcpToolRegistry = mcpToolRegistryLease.registry;
        } catch (error) {
          const registry = await Promise.allSettled([registryLeasePromise]);
          if (registry[0]?.status === "fulfilled") await registry[0].value.release();
          throw error;
        }
        const restoredRuntimeSessionId =
          ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "";
        const toolRuntimeState: ExpertToolRuntimeState = {};
        let expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration | undefined;

        try {
          if (
            restoredRuntimeSessionId !== "" &&
            !(await timedQoderPhase(
              ctx.logger,
              "restore_session_lookup",
              sessionStartedAt,
              async () =>
                await nativeSessionFileExists(
                  join(configDir, "projects"),
                  restoredRuntimeSessionId,
                ),
            ))
          ) {
            throw new Error(
              `Qoder CLI runtime session file was not found: ${restoredRuntimeSessionId}.`,
            );
          }
          expertToolsMcpRegistration = await timedQoderPhase(
            ctx.logger,
            "mcp_tool_registration",
            sessionStartedAt,
            async () =>
              await registerExpertToolsMcpSession({
                agent: ctx.agent,
                getContext: () => ctx.lifecycle.currentContext,
                humanInteractionHandler: ctx.request.humanInteractionHandler,
                logger: ctx.logger,
                mcpTools: mcpToolRegistry.tools,
                state: toolRuntimeState,
                executionContext: ctx.request.executionContext,
              }),
          );
          ctx.logger.info("runtime.qodercli_session_ready", "Qoder Session preparation completed", {
            elapsedMs: qoderElapsedMs(sessionStartedAt),
            systemPromptCharacters: ctx.agentContext.systemPrompt.length,
            toolCount: mcpToolRegistry.tools.length,
          });
          return {
            agent: ctx.agent,
            auth: resolveQoderAuth(options),
            executablePath: resolveQoderCliExecutablePath(options),
            env: { ...ctx.processEnvironment },
            configDir,
            mcpServerUrl: expertToolsMcpRegistration.url,
            plugin,
            logger: ctx.logger,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            permissionMode: options.permissionMode ?? "default",
            defaultModelName: ctx.request.modelSelection?.model.modelId ?? options.defaultModelName,
            defaultThinkingLevel:
              ctx.request.modelSelection?.thinkingLevel ?? options.defaultThinkingLevel,
            contextWindowOverride: options.contextWindowTokens,
            compactModelName: options.compactModelName,
            systemPrompt: ctx.agentContext.systemPrompt,
            toolRuntimeState,
            tokenCounter: options.tokenCounter ?? defaultRuntimeTokenCounter,
            messages: [],
            toolNames: new Map(),
            sessionId: restoredRuntimeSessionId,
            mcpToolRegistry,
            mcpToolRegistryLease,
            expertToolsMcpRegistration,
          };
        } catch (error) {
          await disposeResources(expertToolsMcpRegistration, mcpToolRegistryLease);
          throw error;
        }
      },
      readSession(session) {
        return {
          runtimeSessionId: session.sessionId,
          messages: session.messages,
        };
      },
      listMessages: listQoderMessages,
      async startTurn(session, turn) {
        assertProvider(turn.modelSelection?.model.providerId);
        return await startQoderTurn(session, turn);
      },
      mapEvent: mapQoderEvent,
      readContextWindow: readQoderContextWindow,
      compactContext: compactQoderContextWindow,
      cancelTurn: cancelQoderTurn,
      async closeSession(session) {
        await closeQoderSession(session);
        await disposeResources(session.expertToolsMcpRegistration, session.mcpToolRegistryLease);
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

async function timedQoderPhase<T>(
  logger: Pick<PragmaLogger, "info">,
  phase: string,
  sessionStartedAt: number,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();
  const value = await operation();
  logger.info("runtime.qodercli_prepare_phase", `Qoder preparation phase completed: ${phase}`, {
    phase,
    durationMs: qoderElapsedMs(startedAt),
    elapsedMs: qoderElapsedMs(sessionStartedAt),
  });
  return value;
}

function qoderElapsedMs(startedAt: number): number {
  return Math.round((performance.now() - startedAt) * 100) / 100;
}

async function nativeSessionFileExists(root: string, runtimeSessionId: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await nativeSessionFileExists(path, runtimeSessionId)) return true;
    } else if (entry.isFile() && entry.name === `${runtimeSessionId}.jsonl`) {
      return true;
    }
  }
  return false;
}

function assertProvider(providerId: string | undefined): void {
  if (providerId !== undefined && providerId !== "qoder") {
    throw new Error("Qoder CLI runtime only supports provider qoder.");
  }
}

async function disposeResources(
  registration: ExpertToolsMcpSessionRegistration | undefined,
  registryLease: McpToolRegistryLease | undefined,
): Promise<void> {
  const results = await Promise.allSettled([registration?.dispose(), registryLease?.release()]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Qoder runtime cleanup failed.");
}
