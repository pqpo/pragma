import type { RuntimeAdapter, RuntimeCanUseResult, RuntimeModelSelection } from "@pragma/core";
import {
  createExpertToolsHttpMcpFeature,
  createMcpToolRegistryPool,
  defineRuntimeFeatures,
  defineAcpRuntimeDriver,
  runtimeFeature,
  type RuntimeSessionPersistenceSpec,
} from "@pragma/core";
import { prepareManagedClaudeCodeConfig } from "./claude-config.ts";
import { canUseClaudeCodeRuntime } from "./availability.ts";
import { resolveClaudeCodeCommand } from "./executable.ts";
import { materializeClaudeCodePlugin } from "./skills.ts";
import { createClaudeCompactionHookRelay } from "./compaction-hooks.ts";
import { createClaudeAcpBinding, filterClaudeRuntimeEnv } from "./session.ts";
import type { ClaudeCodeRuntimeAdapterOptions } from "./types.ts";
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

const CLAUDE_CODE_ACCEPTANCE_PENDING =
  "ACP implementation is available; the complete platform/provider acceptance matrix is pending. See docs/architecture/claude-code-runtime.md.";

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
    runtimeFeature.native(runtimeFeature.degraded(CLAUDE_CODE_ACCEPTANCE_PENDING));
  const mcp = createExpertToolsHttpMcpFeature({
    readiness: runtimeFeature.degraded(CLAUDE_CODE_ACCEPTANCE_PENDING),
    pool: mcpToolRegistries,
    resourcePrefix: "claude-code",
  });
  const skills = runtimeFeature.session({
    id: "claude-code.skills",
    readiness: runtimeFeature.degraded(CLAUDE_CODE_ACCEPTANCE_PENDING),
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
    readiness: runtimeFeature.degraded(CLAUDE_CODE_ACCEPTANCE_PENDING),
    prepare() {
      return { mode: options.permissionMode ?? "bypassPermissions" };
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
      runtimeFeature.degraded(CLAUDE_CODE_ACCEPTANCE_PENDING, {
        compactionModes: ["manual", "events"],
      }),
    ),
    cancellation: implemented(),
    steering: implemented(),
    close: implemented(),
    cleanup: implemented(),
  });

  return defineAcpRuntimeDriver(
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
          metadata: { format: "claude-code-session-dir" },
        };
      },
      async prepare(ctx) {
        const sessionDir =
          ctx.persistence.spec?.sessionDir ?? ctx.paths.runtimeSessionDir("claude-code");
        const managedConfig = await prepareManagedClaudeCodeConfig({
          sessionDir,
          env: ctx.processEnvironment,
          logger: ctx.logger,
        });
        let defaultSelection: RuntimeModelSelection | undefined = ctx.request.modelSelection;
        if (
          defaultSelection === undefined &&
          (options.defaultModelName !== undefined || options.defaultThinkingLevel !== undefined)
        ) {
          const models = await listModels();
          assertClaudeCodeModelSelection(
            models,
            options.defaultModelName,
            options.defaultThinkingLevel,
          );
          const model =
            options.defaultModelName === undefined
              ? models.find((candidate) => candidate.default)
              : models.find((candidate) => candidate.id === options.defaultModelName);
          if (model === undefined) throw new Error("Claude model selection has no default model");
          defaultSelection = {
            model: { providerId: model.provider.id, modelId: model.id },
            ...(options.defaultThinkingLevel === undefined
              ? {}
              : { thinkingLevel: options.defaultThinkingLevel }),
          };
        }
        if (defaultSelection !== undefined)
          assertClaudeCodeModelSelection(
            await listModels(),
            defaultSelection.model.modelId,
            defaultSelection.thinkingLevel,
            defaultSelection.model.providerId,
          );
        return createClaudeAcpBinding({
          options: { ...options, listModels },
          workspace: ctx.workspace,
          humanInteractionHandler: ctx.request.humanInteractionHandler,
          systemPrompt: ctx.agentContext.systemPrompt,
          managedConfig,
          cli: command,
          processEnvironment: ctx.processEnvironment,
          pluginDir: ctx.features.skills.pluginDir,
          mcpServerUrl: ctx.features.mcp.registration.url,
          relay: ctx.features.skills.relay,
          defaultSelection,
        });
      },
    },
    {
      sessionRestoreHandler: options.sessionRestoreHandler,
      sessionSyncCallback: options.sessionSyncCallback,
      createProcessEnvironment: () => filterClaudeRuntimeEnv(options.env ?? process.env),
    },
  );
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
      ...(options.acpWorkerPath === undefined ? {} : { acpWorkerPath: options.acpWorkerPath }),
      ...(options.executablePath === undefined ? {} : { executablePath: options.executablePath }),
      ...(options.env === undefined ? {} : { env: options.env }),
    });
}
