import { readdir } from "node:fs/promises";
import { join } from "node:path";

import type {
  McpToolRegistry,
  RuntimeAdapter,
  RuntimeCanUseResult,
  ExpertToolsMcpSessionRegistration,
} from "@pragma/core";
import {
  createMcpToolRegistry,
  defineRuntimeDriver,
  registerExpertToolsMcpSession,
  type PragmaLogger,
  type RuntimeSessionPersistenceSpec,
  type ExpertToolRuntimeState,
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
    supportsAbort: true,
    supportsMcp: true,
    supportsModelDiscovery: true,
    supportsStreaming: true,
    supportsThinkingLevel: true,
    supportsContextCompactionEvents: true,
  },
};
const DEFAULT_CLAUDE_CODE_PERMISSION_MODE = "bypassPermissions" as const;

interface ClaudeCodeDriverSession extends ClaudeCodeNativeSession {
  readonly mcpToolRegistry: McpToolRegistry;
  readonly expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration;
}

export function createClaudeCodeRuntime(
  options: ClaudeCodeRuntimeAdapterOptions = {},
): RuntimeAdapter {
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

  return defineRuntimeDriver(
    {
      descriptor,
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
        const toolRuntimeState: ExpertToolRuntimeState = {};
        const compactionHookRelay = await createClaudeCompactionHookRelay();
        let mcpToolRegistry: McpToolRegistry | undefined;
        let expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration | undefined;

        try {
          const pluginDir = await materializeClaudeCodePlugin({
            agent: ctx.agent,
            sessionDir,
            compactionHook: {
              url: compactionHookRelay.url,
              authorization: compactionHookRelay.authorization,
            },
          });
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
              throw new Error(
                `Claude Code runtime session file was not found: ${state.sessionId}.`,
              );
            }
          }

          return {
            ...createClaudeCodeNativeSession({
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
              mcpServerUrl: expertToolsMcpRegistration.url,
              permissionMode: options.permissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
              pluginDir,
              compactionHookRelay,
              sessionDir,
              spawn: options.spawn,
              startupMessages: state.sessionId === "" ? ctx.agentContext.startupMessages : [],
              state,
              systemPrompt: ctx.agentContext.systemPrompt,
              tokenCounter: options.tokenCounter,
            }),
            mcpToolRegistry,
            expertToolsMcpRegistration,
          };
        } catch (error) {
          const cleanup = await Promise.allSettled([
            disposeClaudeRuntimeResources(expertToolsMcpRegistration, mcpToolRegistry, ctx.logger),
            compactionHookRelay.close(),
          ]);
          const cleanupErrors = cleanup.flatMap((result) =>
            result.status === "rejected" ? [result.reason as unknown] : [],
          );
          if (cleanupErrors.length > 0) {
            throw new AggregateError(
              [error, ...cleanupErrors],
              "Claude Code runtime initialization and cleanup failed.",
              { cause: error },
            );
          }
          throw error;
        }
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
      async closeSession(session, ctx) {
        cancelClaudeCodeTurn(session);
        const cleanup = await Promise.allSettled([
          disposeClaudeRuntimeResources(
            session.expertToolsMcpRegistration,
            session.mcpToolRegistry,
            ctx.logger,
          ),
          session.compactionHookRelay.close(),
        ]);
        const errors = cleanup.flatMap((result) =>
          result.status === "rejected" ? [result.reason as unknown] : [],
        );
        if (errors.length > 0) {
          throw new AggregateError(errors, "Claude Code Runtime cleanup failed.");
        }
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

async function disposeClaudeRuntimeResources(
  expertToolsMcpRegistration: ExpertToolsMcpSessionRegistration | undefined,
  mcpToolRegistry: McpToolRegistry | undefined,
  logger: PragmaLogger,
): Promise<void> {
  const results = await Promise.allSettled([
    expertToolsMcpRegistration?.dispose() ?? Promise.resolve(),
    mcpToolRegistry?.dispose() ?? Promise.resolve(),
  ]);
  const errors = results.flatMap((result) =>
    result.status === "rejected" ? [result.reason as unknown] : [],
  );

  if (errors.length === 0) {
    return;
  }

  logger.error(
    "runtime.claude_cleanup_failed",
    "Claude Code runtime cleanup failed",
    new AggregateError(errors),
  );

  if (errors.length === 1) {
    throw errors[0];
  }

  throw new AggregateError(errors, "Claude Code runtime session cleanup failed.");
}
