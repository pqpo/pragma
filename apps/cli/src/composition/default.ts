import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

import { createAntigravityRuntime } from "@pragma/runtime-antigravity";
import { createClaudeCodeRuntime } from "@pragma/runtime-claude-code";
import { createCodexRuntime } from "@pragma/runtime-codex";
import { createPiRuntime } from "@pragma/runtime-pi";
import { createQoderCliRuntime } from "@pragma/runtime-qodercli";
import {
  createControllerRunMissionPort,
  createCoreRunExecutorPort,
  createLocalHostBuiltInExecutorResolver,
  createLocalHostApplication,
  createLocalHostMissionBoardBindings,
  createLocalHostProjectCatalogFromHome,
  createLocalHostRunApplication,
  createLocalHostRuntimeResolver,
  createLocalHostStderrLoggerProvider,
  createLocalHostUsageSink,
  filterLocalHostRuntimeProcessEnvironment,
  createMissionControllerStore,
  createRuntimeTokenCounter,
  listLocalHostBuiltInExecutorDescriptors,
} from "@pragma/local-host";
import { createIntegrationError } from "@pragma/local-host/wire";

import type { CliLocalHost } from "../commands/types.ts";

export function createCliLocalHost(
  input: { readonly localHost?: CliLocalHost } = {},
): CliLocalHost {
  return input.localHost ?? createProductionLocalHost();
}

function createProductionLocalHost(): CliLocalHost {
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
  const runtimeResolver = createLocalHostRuntimeResolver({
    runtimes,
    defaultRuntimeId: "codex-local",
    runtimeAliases: { codex: "codex-local" },
  });
  const loggerProvider = createLocalHostStderrLoggerProvider();
  const resolveBuiltInExecutor = createLocalHostBuiltInExecutorResolver({
    pragmaHome,
    runtimes: runtimeResolver,
    loggerProvider,
  });
  const projectCatalog = createLocalHostProjectCatalogFromHome({
    pragmaHome,
    projectId: process.env["PRAGMA_PROJECT_ID"]?.trim() || undefined,
    runtimes: runtimeResolver,
    loggerProvider,
  });
  const missionController = createMissionControllerStore({
    missionsPath: join(pragmaHome, "data", "missions"),
  });
  const usageSink = createLocalHostUsageSink({
    path: join(pragmaHome, "data", "usage", "observations.json"),
  });
  const executorPort = createCoreRunExecutorPort({
    pragmaHome,
    runtimes: runtimeResolver,
    usageSink,
    loggerProvider,
    createHostContextBindings: async ({ missionId }) =>
      await createLocalHostMissionBoardBindings({ pragmaHome, missionId }),
    executors: async (input) =>
      (await resolveBuiltInExecutor({ ref: input.ref, workspace: input.workspace })) ??
      (await projectCatalog.resolve(input)),
  });
  const run = createLocalHostRunApplication({
    executors: executorPort,
    mission: createControllerRunMissionPort(missionController),
  });
  const application = createLocalHostApplication({
    integrationCapability: async () => ({
      schemaVersion: "pragma.integration-capability/v1" as const,
      protocol: "pragma.integration/v2" as const,
      readableVersions: ["pragma.integration/v1" as const, "pragma.integration/v2" as const],
      migratableFromVersions: [],
      features: ["run", "human-interaction", "idempotency", "workspace.resolve"],
    }),
    catalog: {
      listProjects: async () => await projectCatalog.listProjects(),
      getProjectRevision: async (projectId, revision) =>
        await projectCatalog.getProjectRevision(projectId, revision),
      listExecutors: async () =>
        await [
          ...(await listLocalHostBuiltInExecutorDescriptors({ runtimes: runtimeResolver })),
          ...(await projectCatalog.listExecutors()),
        ],
    },
    missions: {
      get: async (missionId) => await readMissionSnapshot(missionController, missionId),
      list: async () => [],
    },
    workspace: {
      stat: async (path) => await stat(path),
      access: async (path, mode) => await access(path, mode === "read" ? 4 : 2),
      realpath: async (path) => await realpath(path),
    },
    board: {
      list: async () => unavailableBoard(),
      read: async () => unavailableBoard(),
      search: async () => unavailableBoard(),
    },
    queue: { list: async () => unavailableQueue() },
    runtime: { resolver: runtimeResolver },
    run,
  });
  return application;
}

function unavailableBoard(): never {
  throw createIntegrationError({
    code: "DEPENDENCY_UNAVAILABLE",
    category: "dependency",
    message: "The CLI Local Host shared Board is not configured.",
  });
}

function unavailableQueue(): never {
  throw createIntegrationError({
    code: "DEPENDENCY_UNAVAILABLE",
    category: "dependency",
    message: "The CLI Local Host Mission queue is not configured.",
  });
}

async function readMissionSnapshot(
  controller: ReturnType<typeof createMissionControllerStore>,
  missionId: string,
): Promise<unknown> {
  return await controller.readSnapshot({ missionId });
}
