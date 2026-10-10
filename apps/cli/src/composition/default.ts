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
  createRuntimeProcessEnvironmentSettingsStore,
  resolveLocalHostRuntimeProcessEnvironment,
} from "@pragma/local-host";
import { createLocalHostNodeApplication } from "@pragma/local-host/node-application";

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
  const environmentSettings = createRuntimeProcessEnvironmentSettingsStore({
    pragmaHome,
  }).getSync();
  const getRuntimeEnvironment = (runtimeAdapterId: string): NodeJS.ProcessEnv =>
    resolveLocalHostRuntimeProcessEnvironment(
      process.env,
      runtimeAdapterId,
      environmentSettings.policy,
    );
  const tokenCounter = createRuntimeTokenCounter();
  const runtimes = [
    createCodexRuntime({
      env: getRuntimeEnvironment("pragma.runtime.codex"),
      tokenCounter,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    }),
    createOpenCodeRuntime({
      env: getRuntimeEnvironment("pragma.runtime.opencode"),
      permissionMode: "request-approval",
      tokenCounter,
    }),
    createClaudeCodeRuntime({
      env: getRuntimeEnvironment("pragma.runtime.claude-code"),
      permissionMode: "default",
      tokenCounter,
    }),
    createQoderCliRuntime({
      env: getRuntimeEnvironment("pragma.runtime.qodercli"),
      permissionMode: "default",
      tokenCounter,
    }),
    createAntigravityRuntime({
      env: getRuntimeEnvironment("pragma.runtime.antigravity"),
      permissionMode: "request-approval",
      tokenCounter,
    }),
    createPiRuntime({ env: getRuntimeEnvironment("pragma.runtime.pi"), tokenCounter }),
  ];

  return createLocalHostNodeApplication({
    pragmaHome,
    runtimes,
    defaultRuntimeId: "codex-local",
    runtimeAliases: { codex: "codex-local" },
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
