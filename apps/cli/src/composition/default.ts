import type { ToolPermissionMode } from "@pragma/shared";
import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAntigravityRuntime } from "@pragma/runtime-antigravity";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createOpenCodeRuntime } from "@pragma/runtime-opencode";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";
import {
  createRuntimeTokenCounter,
  createLocalHostRuntimeResolver,
  withExactLegacyRuntimeBindings,
  createRuntimeProcessEnvironmentSettingsStore,
  resolveLocalHostRuntimeProcessEnvironment,
} from "@pragma/local-host";
import { createLocalHostNodeApplication } from "@pragma/local-host/node-application";

import {
  assertEmptyBuiltInRuntimeConfig,
  createLocalHostRuntimeConfiguration,
  createRuntimeEnvironmentService,
  DEFAULT_RUNTIME_ENVIRONMENTS,
  type RuntimeEnvironmentAdapterFactory,
} from "@pragma/local-host/deployment";

import type { CliLocalHost } from "../commands/types.ts";
import { CLI_VERSION } from "../version.ts";

export function createCliLocalHost(
  input: { readonly localHost?: CliLocalHost } = {},
): CliLocalHost {
  return input.localHost ?? createProductionLocalHost();
}

/**
 * CLI composition owns only process concerns and concrete Runtime adapters.
 * Durable Mission, Board, Project and Core wiring is assembled by Local Host
 * so Desktop Main can reuse the same application layer.
 */
export function createProductionLocalHost(): CliLocalHost {
  const pragmaHome = process.env["PRAGMA_HOME"]?.trim() || join(homedir(), ".pragma");
  const configuration = createLocalHostRuntimeConfiguration({ pragmaHome });
  const environmentSettings = createRuntimeProcessEnvironmentSettingsStore({ pragmaHome });
  const tokenCounter = createRuntimeTokenCounter();
  const factories: readonly RuntimeEnvironmentAdapterFactory[] = DEFAULT_RUNTIME_ENVIRONMENTS.map(
    ({ adapter }) => ({
      ...adapter,
      prepare: (environment, context) => {
        const settings = environmentSettings.getSync();
        return {
          cacheKey: JSON.stringify(settings),
          create: () => createAdapter(environment, context, settings.policy),
        };
      },
      create: (environment, context) =>
        createAdapter(environment, context, environmentSettings.getSync().policy),
    }),
  );

  function createAdapter(
    environment: Parameters<RuntimeEnvironmentAdapterFactory["create"]>[0],
    context: Parameters<RuntimeEnvironmentAdapterFactory["create"]>[1],
    policy: ReturnType<typeof environmentSettings.getSync>["policy"],
  ) {
    const adapter = environment.adapter;
    assertEmptyBuiltInRuntimeConfig(environment);
    const mode = context?.toolPermissionMode ?? "request-approval";
    const permissionMode =
      mode === "request-approval"
        ? "default"
        : mode === "auto-approve"
          ? "auto"
          : "bypassPermissions";
    const common = {
      descriptor: { id: environment.id, displayName: environment.displayName },
      env: resolveLocalHostRuntimeProcessEnvironment(process.env, adapter.id, policy),
      tokenCounter,
      modelCatalogCacheRoot: join(pragmaHome, "cache"),
    };
    switch (adapter.id) {
      case "pragma.runtime.pi":
        return createPiRuntime({ ...common, modelProviders: configuration.modelProviders });
      case "pragma.runtime.codex":
        return createCodexRuntime({
          ...common,
          sandboxMode: mode === "full-access" ? "danger-full-access" : "workspace-write",
          approvalPolicy: mode === "full-access" ? "never" : "on-request",
        });
      case "pragma.runtime.opencode":
        return createOpenCodeRuntime({ ...common, permissionMode: mode });
      case "pragma.runtime.claude-code":
        return createClaudeCodeRuntime({ ...common, permissionMode });
      case "pragma.runtime.qodercli":
        return createQoderCliRuntime({ ...common, permissionMode });
      case "pragma.runtime.antigravity":
        return createAntigravityRuntime({
          ...common,
          permissionMode: mode,
          authenticationMode: "auto",
        });
      default:
        throw new Error(`Runtime adapter factory is not registered: ${adapter.id}.`);
    }
  }
  const runtimes = createRuntimeEnvironmentService({
    store: configuration.environments,
    factories,
  });

  // Read support for Contexts written by the previous CLI composition. This is
  // lazy and resolve-only: it cannot create new static bindings or change IDs.
  const legacy = new Map<
    ToolPermissionMode,
    { key: string; resolver: ReturnType<typeof createLocalHostRuntimeResolver> }
  >();
  const legacyRuntimes = (mode: ToolPermissionMode) => {
    const settings = environmentSettings.getSync();
    const key = JSON.stringify(settings);
    const cached = legacy.get(mode);
    if (cached?.key === key) return cached.resolver;
    const legacyEnvironment = (id: string) =>
      resolveLocalHostRuntimeProcessEnvironment(process.env, id, settings.policy);
    const permissionMode =
      mode === "request-approval"
        ? "default"
        : mode === "auto-approve"
          ? "auto"
          : "bypassPermissions";
    const resolver = createLocalHostRuntimeResolver({
      defaultRuntimeId: "codex-local",
      runtimeAliases: { codex: "codex-local" },
      runtimes: [
        createCodexRuntime({
          env: legacyEnvironment("pragma.runtime.codex"),
          tokenCounter,
          sandboxMode: mode === "full-access" ? "danger-full-access" : "workspace-write",
          approvalPolicy: mode === "full-access" ? "never" : "on-request",
        }),
        createOpenCodeRuntime({
          env: legacyEnvironment("pragma.runtime.opencode"),
          tokenCounter,
          permissionMode: mode,
        }),
        createClaudeCodeRuntime({
          env: legacyEnvironment("pragma.runtime.claude-code"),
          tokenCounter,
          permissionMode,
        }),
        createQoderCliRuntime({
          env: legacyEnvironment("pragma.runtime.qodercli"),
          tokenCounter,
          permissionMode,
        }),
        createAntigravityRuntime({
          env: legacyEnvironment("pragma.runtime.antigravity"),
          tokenCounter,
          permissionMode: mode,
        }),
        createPiRuntime({ env: legacyEnvironment("pragma.runtime.pi"), tokenCounter }),
      ],
    });
    legacy.set(mode, { key, resolver });
    return resolver;
  };
  const compatible = (
    current: Parameters<typeof withExactLegacyRuntimeBindings>[0]["current"],
    mode: ToolPermissionMode = "request-approval",
  ) => withExactLegacyRuntimeBindings({ current, legacy: () => legacyRuntimes(mode) });

  return createLocalHostNodeApplication({
    pragmaHome,
    runtimes: compatible(runtimes),
    runtimesForToolPermissionMode: (mode) => compatible(runtimes.forToolPermissionMode(mode), mode),
    projectId: process.env["PRAGMA_PROJECT_ID"]?.trim() || undefined,
    client: {
      surface: "cli",
      version: CLI_VERSION,
      instanceId: randomUUID(),
    },
    workspace: {
      stat: async (path) => await stat(path),
      access: async (path, mode) => await access(path, mode === "read" ? 4 : 2),
      realpath: async (path) => await realpath(path),
    },
  });
}
