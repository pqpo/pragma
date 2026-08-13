import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type { RuntimeAdapter, RuntimeCanUseResult } from "@pragma/core";
import {
  createExpertToolsHttpMcpFeature,
  createMcpToolRegistryPool,
  defineRuntimeFeatures,
  defineRuntimeDriver,
  runtimeFeature,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";
import { prepareManagedClaudeCodeConfig } from "./claude-config.ts";
import { canUseClaudeCodeRuntime } from "./availability.ts";
import { resolveClaudeCodeCommand } from "./executable.ts";
import { materializeClaudeCodePlugin } from "./skills.ts";
import { createClaudeCompactionHookRelay } from "./compaction-hooks.ts";
import {
  cancelClaudeCodeTurn,
  collectClaudeCodeUsage,
  compactClaudeCodeContextWindow,
  consumeClaudeCodeStartupMessages,
  createClaudeCodeNativeSession,
  filterClaudeRuntimeEnv,
  listClaudeCodeMessages,
  mapClaudeCodeNativeEvent,
  readClaudeCodeContextWindow,
  startClaudeCodeTurn,
  type ClaudeCodeNativeSession,
} from "./session.ts";
import type { ClaudeCodeRuntimeAdapterOptions, ClaudeCodeRuntimeSessionState } from "./types.ts";
import { assertClaudeCodeModelSelection, createClaudeCodeModelDiscovery } from "./models.ts";

const CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR = {
  id: "claude-code-local",
  kind: "claude-code-local" as const,
  displayName: "Claude Code Local",
  capabilities: {
    targets: ["agent"],
    executionLocations: ["local"],
  },
};

const CLAUDE_CODE_EVIDENCE_PENDING =
  "Implemented in the adapter; an executed Runtime probe evidence bundle is not recorded yet.";
const DEFAULT_CLAUDE_CODE_PERMISSION_MODE = "bypassPermissions" as const;

type ClaudeCodeDriverSession = ClaudeCodeNativeSession;

export function createClaudeCodeRuntime(
  options: ClaudeCodeRuntimeAdapterOptions = {},
): RuntimeAdapter {
  const mcpToolRegistries = options.mcpToolRegistryPool ?? createMcpToolRegistryPool();
  const command =
    options.spawn === undefined
      ? resolveClaudeCodeCommand(options)
      : {
          executablePath: options.executablePath ?? "claude",
          launcherArgs: [] as readonly string[],
        };
  const descriptor = {
    ...CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR,
    ...options.descriptor,
    kind: options.descriptor?.kind ?? CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR.kind,
    capabilities: {
      ...CLAUDE_CODE_LOCAL_RUNTIME_DESCRIPTOR.capabilities,
      ...options.descriptor?.capabilities,
    },
  };
  const listModels = options.listModels ?? createClaudeCodeModelDiscovery(options);
  const implemented = () =>
    runtimeFeature.native(runtimeFeature.degraded(CLAUDE_CODE_EVIDENCE_PENDING));
  const mcp = createExpertToolsHttpMcpFeature({
    readiness: runtimeFeature.degraded(CLAUDE_CODE_EVIDENCE_PENDING),
    pool: mcpToolRegistries,
    resourcePrefix: "claude-code",
  });
  const skills = runtimeFeature.session({
    id: "claude-code.skills",
    readiness: runtimeFeature.degraded(CLAUDE_CODE_EVIDENCE_PENDING),
    async prepare(ctx) {
      const relay = await ctx.resources.acquire(
        "claude-code.compaction-relay",
        createClaudeCompactionHookRelay,
        async (value) => await value.close(),
      );
      const sessionDir =
        ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("claude-code");
      const pluginDir = await materializeClaudeCodePlugin({
        agent: ctx.agent,
        sessionDir,
        compactionHook: { url: relay.url, authorization: relay.authorization },
      });
      return { relay, pluginDir };
    },
  });
  const permissions = runtimeFeature.session({
    id: "claude-code.permissions",
    readiness: runtimeFeature.degraded(CLAUDE_CODE_EVIDENCE_PENDING),
    prepare() {
      return { mode: options.permissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE };
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
      runtimeFeature.degraded(CLAUDE_CODE_EVIDENCE_PENDING, {
        compactionModes: ["manual", "events"],
      }),
    ),
    cancellation: implemented(),
    steering: runtimeFeature.native(
      runtimeFeature.unsupported(
        "Claude Code stream-json mode exposes no safe active-turn steering API.",
      ),
    ),
    close: implemented(),
    cleanup: implemented(),
  });

  return defineRuntimeDriver(
    {
      descriptor,
      features,
      canUse: createClaudeCodeRuntimeCanUse(options),
      listModels,
      outputRetryLimit: options.outputRetryLimit,
      resolvePersistence(ctx): RuntimeSessionPersistenceSpec {
        return {
          mode: "checkpoint",
          sessionDir: ctx.paths.runtimeSessionDir("claude-code"),
          watch: true,
          checkpointOn: [
            "session.created",
            "runtimeSessionId.changed",
            "turn.completed",
            "context.compacted",
            "session.destroyed",
            "files.changed",
          ],
          metadata: {
            format: "claude-code-session-dir",
          },
        };
      },
      async createSession(ctx): Promise<ClaudeCodeDriverSession> {
        assertRuntimeManagedProvider(
          ctx.request.modelSelection?.model.providerId,
          "anthropic",
          "Claude Code",
        );
        const defaultModelName =
          ctx.request.modelSelection?.model.modelId ?? options.defaultModelName;
        const defaultThinkingLevel =
          ctx.request.modelSelection?.thinkingLevel ?? options.defaultThinkingLevel;
        if (defaultModelName !== undefined || defaultThinkingLevel !== undefined) {
          assertClaudeCodeModelSelection(
            await listModels(),
            defaultModelName,
            defaultThinkingLevel,
          );
        }
        const sessionDir =
          ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("claude-code");
        const state: ClaudeCodeRuntimeSessionState = {
          sessionId:
            ctx.persistence.restoredRuntimeSessionId ?? ctx.request.runtimeSession?.id ?? "",
        };
        const mcp = ctx.features.mcp;
        const skills = ctx.features.skills;
        const managedConfig = await prepareManagedClaudeCodeConfig({
          sessionDir,
          env: ctx.processEnvironment,
          logger: ctx.logger,
        });
        if (state.sessionId !== "") {
          const exists = await nativeSessionFileExists(
            join(managedConfig.configDir, "projects"),
            state.sessionId,
          );
          if (!exists) {
            throw new Error(`Claude Code runtime session file was not found: ${state.sessionId}.`);
          }
        }
        ctx.logger.info(
          "runtime.claude_code_session_ready",
          "Claude Code Session preparation completed",
          {
            systemPromptCharacters: ctx.agentContext.systemPrompt.length,
            toolCount: mcp.registry.tools.length,
            mcpOpenedConnections: mcp.lease.stats.openedConnections,
            mcpReusedConnections: mcp.lease.stats.reusedConnections,
            mcpCoalescedConnections: mcp.lease.stats.coalescedConnections,
          },
        );

        return createClaudeCodeNativeSession({
          agent: ctx.agent,
          executablePath: command.executablePath,
          launcherArgs: command.launcherArgs,
          additionalArgs: options.additionalArgs ?? [],
          defaultModelName,
          defaultThinkingLevel,
          env: ctx.processEnvironment,
          humanInteractionHandler: ctx.request.humanInteractionHandler,
          logger: ctx.logger,
          managedConfig,
          mcpServerUrl: mcp.registration.url,
          permissionMode: ctx.features.permissions.mode,
          pluginDir: skills.pluginDir,
          compactionHookRelay: skills.relay,
          sessionDir,
          spawn: options.spawn,
          startupMessages: state.sessionId === "" ? ctx.agentContext.startupMessages : [],
          state,
          systemPrompt: ctx.agentContext.systemPrompt,
          tokenCounter: options.tokenCounter,
        });
      },
      readSession(session) {
        return {
          runtimeSessionId: session.state.sessionId,
        };
      },
      listMessages: listClaudeCodeMessages,
      consumeStartupMessages: consumeClaudeCodeStartupMessages,
      async startTurn(session, turn) {
        assertRuntimeManagedProvider(
          turn.modelSelection?.model.providerId,
          "anthropic",
          "Claude Code",
        );
        const modelName = turn.modelSelection?.model.modelId ?? session.defaultModelName;
        const thinkingLevel = turn.modelSelection?.thinkingLevel ?? session.defaultThinkingLevel;
        if (modelName !== undefined || thinkingLevel !== undefined) {
          assertClaudeCodeModelSelection(await listModels(), modelName, thinkingLevel);
        }
        return await startClaudeCodeTurn(session, {
          ...turn,
          modelSelection:
            modelName === undefined
              ? undefined
              : { model: { providerId: "anthropic", modelId: modelName }, thinkingLevel },
        });
      },
      mapEvent: mapClaudeCodeNativeEvent,
      async collectUsage(session, ctx) {
        return await collectClaudeCodeUsage(session, ctx.startedAt, ctx.usage);
      },
      readContextWindow: readClaudeCodeContextWindow,
      compactContext: compactClaudeCodeContextWindow,
      cancelTurn(session) {
        cancelClaudeCodeTurn(session);
      },
      closeSession(session) {
        cancelClaudeCodeTurn(session);
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
      createProcessEnvironment: () => ({
        ...filterClaudeRuntimeEnv(process.env),
        ...(options.env ?? {}),
      }),
    },
  );
}

function assertRuntimeManagedProvider(
  providerId: string | undefined,
  expectedProviderId: string,
  runtime: string,
): void {
  if (providerId !== undefined && providerId !== expectedProviderId) {
    throw new Error(`${runtime} runtime only supports provider ${expectedProviderId}.`);
  }
}

async function nativeSessionFileExists(root: string, runtimeSessionId: string): Promise<boolean> {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      if (await nativeSessionFileExists(path, runtimeSessionId)) {
        return true;
      }
    } else if (entry.isFile() && entry.name === `${runtimeSessionId}.jsonl`) {
      return true;
    }
  }
  return false;
}

function createClaudeCodeRuntimeCanUse(
  options: ClaudeCodeRuntimeAdapterOptions,
): () => Promise<RuntimeCanUseResult> | RuntimeCanUseResult {
  if (options.canUse !== undefined) {
    return options.canUse;
  }

  if (options.spawn !== undefined) {
    return () => ({
      usable: true,
      details: {
        probe: "skipped",
        reason: "Custom Claude Code spawn was provided.",
      },
    });
  }

  return async () =>
    await canUseClaudeCodeRuntime({
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
}
