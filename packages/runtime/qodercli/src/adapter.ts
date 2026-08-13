import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createExpertToolsHttpMcpFeature,
  createMcpToolRegistryPool,
  defaultRuntimeTokenCounter,
  defineRuntimeFeatures,
  defineRuntimeDriver,
  runtimeFeature,
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
  consumeQoderStartupMessages,
  listQoderMessages,
  mapQoderEvent,
  readQoderContextWindow,
  steerQoderTurn,
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
  },
};

const QODER_EVIDENCE_PENDING =
  "Implemented in the adapter; an executed Runtime probe evidence bundle is not recorded yet.";

type QoderDriverSession = QoderNativeSession;

export function createQoderCliRuntime(options: QoderCliRuntimeAdapterOptions = {}): RuntimeAdapter {
  const mcpToolRegistries = options.mcpToolRegistryPool ?? createMcpToolRegistryPool();
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
  const implemented = () => runtimeFeature.native(runtimeFeature.degraded(QODER_EVIDENCE_PENDING));
  const mcp = createExpertToolsHttpMcpFeature({
    readiness: runtimeFeature.degraded(QODER_EVIDENCE_PENDING),
    pool: mcpToolRegistries,
    resourcePrefix: "qodercli",
  });
  const skills = runtimeFeature.session({
    id: "qodercli.skills",
    readiness: runtimeFeature.degraded(QODER_EVIDENCE_PENDING),
    async prepare(ctx) {
      const sessionDir = ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("qodercli");
      return await materializeQoderSkillPlugin(ctx.agent, sessionDir);
    },
  });
  const permissions = runtimeFeature.session({
    id: "qodercli.permissions",
    readiness: runtimeFeature.degraded(QODER_EVIDENCE_PENDING),
    prepare() {
      return { mode: options.permissionMode ?? "default" };
    },
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
    attachmentImage: implemented(),
    attachmentFile: implemented(),
    attachmentDirectory: implemented(),
    usage: implemented(),
    contextWindow: implemented(),
    compaction: runtimeFeature.native(
      runtimeFeature.degraded(QODER_EVIDENCE_PENDING, { compactionModes: ["manual", "events"] }),
    ),
    cancellation: implemented(),
    steering: implemented(),
    close: implemented(),
    cleanup: implemented(),
  });

  return defineRuntimeDriver(
    {
      descriptor,
      features,
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
              externalCommandsCacheDir: ctx.paths.pragma.qoderCliExternalCommandsCacheRoot(),
              env: ctx.processEnvironment,
              logger: ctx.logger,
            }),
        );
        const [managedConfig] = await Promise.all([configPromise]);
        const mcp = ctx.features.mcp;
        const plugin = ctx.features.skills;
        const restoredRuntimeSessionId =
          ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "";

        if (
          restoredRuntimeSessionId !== "" &&
          !(await timedQoderPhase(
            ctx.logger,
            "restore_session_lookup",
            sessionStartedAt,
            async () =>
              await nativeSessionFileExists(
                join(managedConfig.configDir, "projects"),
                restoredRuntimeSessionId,
              ),
          ))
        ) {
          throw new Error(
            `Qoder CLI runtime session file was not found: ${restoredRuntimeSessionId}.`,
          );
        }
        ctx.logger.info("runtime.qodercli_session_ready", "Qoder Session preparation completed", {
          elapsedMs: qoderElapsedMs(sessionStartedAt),
          systemPromptCharacters: ctx.agentContext.systemPrompt.length,
          toolCount: mcp.registry.tools.length,
          mcpOpenedConnections: mcp.lease.stats.openedConnections,
          mcpReusedConnections: mcp.lease.stats.reusedConnections,
          mcpCoalescedConnections: mcp.lease.stats.coalescedConnections,
        });
        return {
          agent: ctx.agent,
          auth: resolveQoderAuth(options),
          executablePath: resolveQoderCliExecutablePath(options),
          env: { ...ctx.processEnvironment },
          configDir: managedConfig.configDir,
          externalCommandsCacheDir: managedConfig.externalCommandsCacheDir,
          mcpServerUrl: mcp.registration.url,
          plugin,
          logger: ctx.logger,
          humanInteractionHandler: ctx.request.humanInteractionHandler,
          permissionMode: ctx.features.permissions.mode,
          defaultModelName: ctx.request.modelSelection?.model.modelId ?? options.defaultModelName,
          defaultThinkingLevel:
            ctx.request.modelSelection?.thinkingLevel ?? options.defaultThinkingLevel,
          contextWindowOverride: options.contextWindowTokens,
          compactModelName: options.compactModelName,
          systemPrompt: ctx.agentContext.systemPrompt,
          toolRuntimeState: mcp.toolRuntimeState,
          tokenCounter: options.tokenCounter ?? defaultRuntimeTokenCounter,
          messages: [],
          toolNames: new Map(),
          pendingStartupMessages:
            restoredRuntimeSessionId === "" ? ctx.agentContext.startupMessages : [],
          sessionId: restoredRuntimeSessionId,
        };
      },
      readSession(session) {
        return {
          runtimeSessionId: session.sessionId,
          messages: session.messages,
        };
      },
      listMessages: listQoderMessages,
      consumeStartupMessages: consumeQoderStartupMessages,
      async startTurn(session, turn) {
        assertProvider(turn.modelSelection?.model.providerId);
        return await startQoderTurn(session, turn);
      },
      mapEvent: mapQoderEvent,
      readContextWindow: readQoderContextWindow,
      compactContext: compactQoderContextWindow,
      cancelTurn: cancelQoderTurn,
      steerTurn: steerQoderTurn,
      async closeSession(session) {
        await closeQoderSession(session);
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
