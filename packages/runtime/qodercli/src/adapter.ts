import { readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  createMcpToolRegistry,
  defineRuntimeDriver,
  registerExpertToolsMcpSession,
  type ExpertToolsMcpSessionRegistration,
  type ExpertToolRuntimeState,
  type McpToolRegistry,
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
  },
};

interface QoderDriverSession extends QoderNativeSession {
  readonly mcpToolRegistry: McpToolRegistry;
  readonly expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration;
}

export function createQoderCliRuntime(
  options: QoderCliRuntimeAdapterOptions = {},
): RuntimeAdapter {
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
        assertProvider(ctx.request.modelSelection?.model.providerId);
        const sessionDir =
          ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("qodercli");
        const configDir = await prepareManagedQoderConfig({
          sessionDir,
          env: ctx.processEnvironment,
          logger: ctx.logger,
        });
        const restoredRuntimeSessionId =
          ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "";
        if (
          restoredRuntimeSessionId !== "" &&
          !(await nativeSessionFileExists(
            join(configDir, "projects"),
            restoredRuntimeSessionId,
          ))
        ) {
          throw new Error(
            `Qoder CLI runtime session file was not found: ${restoredRuntimeSessionId}.`,
          );
        }
        const plugin = await materializeQoderSkillPlugin(ctx.agent, sessionDir);
        const toolRuntimeState: ExpertToolRuntimeState = {};
        let mcpToolRegistry: McpToolRegistry | undefined;
        let expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration | undefined;

        try {
          mcpToolRegistry = await createMcpToolRegistry(ctx.agent.mcp);
          expertToolsMcpRegistration = await registerExpertToolsMcpSession({
            agent: ctx.agent,
            getContext: () => ctx.lifecycle.currentContext,
            humanInteractionHandler: ctx.request.humanInteractionHandler,
            logger: ctx.logger,
            mcpTools: mcpToolRegistry.tools,
            state: toolRuntimeState,
            executionContext: ctx.request.executionContext,
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
            defaultModelName:
              ctx.request.modelSelection?.model.modelId ?? options.defaultModelName,
            defaultThinkingLevel:
              ctx.request.modelSelection?.thinkingLevel ?? options.defaultThinkingLevel,
            contextWindowOverride: options.contextWindowTokens,
            compactModelName: options.compactModelName,
            systemPrompt: ctx.agentContext.systemPrompt,
            toolRuntimeState,
            messages: [],
            toolNames: new Map(),
            sessionId: restoredRuntimeSessionId,
            mcpToolRegistry,
            expertToolsMcpRegistration,
          };
        } catch (error) {
          await disposeResources(expertToolsMcpRegistration, mcpToolRegistry);
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
        await disposeResources(
          session.expertToolsMcpRegistration,
          session.mcpToolRegistry,
        );
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

async function nativeSessionFileExists(
  root: string,
  runtimeSessionId: string,
): Promise<boolean> {
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
  registry: McpToolRegistry | undefined,
): Promise<void> {
  const results = await Promise.allSettled([
    registration?.dispose(),
    registry?.dispose(),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Qoder runtime cleanup failed.");
}
