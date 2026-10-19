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
      create: (environment, context) => {
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
          env: resolveLocalHostRuntimeProcessEnvironment(
            process.env,
            adapter.id,
            environmentSettings.getSync().policy,
          ),
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
      },
    }),
  );
  const runtimes = createRuntimeEnvironmentService({
    store: configuration.environments,
    factories,
    getMaterializationCacheKey: () => JSON.stringify(environmentSettings.getSync()),
  });

  // Read support for Contexts written by the previous CLI composition. This is
  // lazy and resolve-only: it cannot create new static bindings or change IDs.
  let legacy: ReturnType<typeof createLocalHostRuntimeResolver> | undefined;
  const legacyRuntimes = () =>
    (legacy ??= createLocalHostRuntimeResolver({
      defaultRuntimeId: "codex-local",
      runtimeAliases: { codex: "codex-local" },
      runtimes: [
        createCodexRuntime({
          env: legacyEnvironment("pragma.runtime.codex"),
          tokenCounter,
          sandboxMode: "workspace-write",
          approvalPolicy: "on-request",
        }),
        createOpenCodeRuntime({
          env: legacyEnvironment("pragma.runtime.opencode"),
          tokenCounter,
          permissionMode: "request-approval",
        }),
        createClaudeCodeRuntime({
          env: legacyEnvironment("pragma.runtime.claude-code"),
          tokenCounter,
          permissionMode: "default",
        }),
        createQoderCliRuntime({
          env: legacyEnvironment("pragma.runtime.qodercli"),
          tokenCounter,
          permissionMode: "default",
        }),
        createAntigravityRuntime({
          env: legacyEnvironment("pragma.runtime.antigravity"),
          tokenCounter,
          permissionMode: "request-approval",
        }),
        createPiRuntime({ env: legacyEnvironment("pragma.runtime.pi"), tokenCounter }),
      ],
    }));
  const legacyEnvironment = (id: string) =>
    resolveLocalHostRuntimeProcessEnvironment(
      process.env,
      id,
      environmentSettings.getSync().policy,
    );
  const compatible = (current: Parameters<typeof withExactLegacyRuntimeBindings>[0]["current"]) =>
    withExactLegacyRuntimeBindings({ current, legacy: legacyRuntimes });

  return createLocalHostNodeApplication({
    pragmaHome,
    runtimes: compatible(runtimes),
    runtimesForToolPermissionMode: (mode) => compatible(runtimes.forToolPermissionMode(mode)),
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
