import { randomUUID } from "node:crypto";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAntigravityRuntime } from "@pragma/runtime-antigravity";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";
import {
  createRuntimeTokenCounter,
  filterLocalHostRuntimeProcessEnvironment,
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
  const environment = filterLocalHostRuntimeProcessEnvironment(process.env);
  const tokenCounter = createRuntimeTokenCounter();
  const runtimes = [
    createCodexRuntime({
      env: environment,
      tokenCounter,
      sandboxMode: "workspace-write",
      approvalPolicy: "on-request",
    }),
    createClaudeCodeRuntime({ env: environment, permissionMode: "default", tokenCounter }),
    createQoderCliRuntime({ env: environment, permissionMode: "default", tokenCounter }),
    createAntigravityRuntime({
      env: environment,
      permissionMode: "request-approval",
      tokenCounter,
    }),
    createPiRuntime({ env: environment, tokenCounter }),
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
