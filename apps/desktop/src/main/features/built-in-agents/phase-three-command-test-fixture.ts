import { createDesktopRuntimeOptionResource } from "../../platform/bindings/desktop-bound-resource-policy.ts";
import { join } from "node:path";
import { PragmaPaths, type RuntimeResolver } from "@pragma/core";
import {
  createLocalHostMissionApplication,
  createLocalHostMissionController,
  createLocalHostPragmaMissionPort,
  createLocalHostPragmaAutomationPort,
  createMissionStore,
  createSqliteExecutionStore,
} from "@pragma/local-host";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaExpertResourceSchema,
  canonicalPragmaResourceRef,
} from "@pragma/interpreter/ast";
import { createPragmaProjectStore } from "../projects/pragma-project-store.ts";
import { createMissionCreator } from "../missions/mission-creator.ts";
import { createDesktopMissionExecutionResources } from "../missions/desktop-mission-execution-resources.ts";
import { createAutomationStore } from "../automations/automation-store.ts";
import { createAutomationService } from "../automations/automation-service.ts";
import { createContextStoreStore } from "../context-stores/context-store-store.ts";
import { createHomeProjectStore } from "../missions/home-project-store.ts";
import { createWorkspaceHistoryStore } from "../workspaces/workspace-history-store.ts";
import { createDesktopPragmaAgentResourceCatalogPort } from "./pragma-agent-resource-adapter.ts";

/** Real Host repositories/application/scheduler ports for subprocess tests and native probes. */
export async function createPhaseThreeCommandTestFixture(
  root: string,
  runtimes: RuntimeResolver,
  workspace = root,
  onStorageTrashed?: () => void,
) {
  const paths = new PragmaPaths({ pragmaHome: root });
  const project = createPragmaProjectStore({ projectsPath: paths.projectsRoot() });
  const resolved = await runtimes.bind();
  const models = await resolved.adapter.listModels?.();
  const model = models?.find((item) => item.default) ?? models?.[0];
  const runtime = createDesktopRuntimeOptionResource({
    runtimeId: resolved.adapter.descriptor.id,
    providerId: model?.provider.id ?? "test",
    modelId: model?.id ?? "test-model",
    name: "Command delegate Runtime",
    description: "Isolated test Runtime",
  });
  const resource = PragmaExpertResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "00000000000pr0be",
      name: "Command delegate",
      description: "Isolated command test",
      tags: [],
    },
    spec: {
      runtime: { ref: canonicalPragmaResourceRef(runtime) },
      scope: "Follow the prompt. Reply briefly; use no tools unless needed.",
      instructions: "Reply ok to ordinary requests.",
      capabilities: [],
      contextStores: [],
      tools: [],
      plugins: [],
      toolApprovals: {},
    },
  });
  await project.publish({ expectedRevision: 0, resources: [runtime, resource] });
  const executor = {
    kind: "expert" as const,
    avatarId: "pragma.avatar.expert.default",
    ref: `expert:${resource.metadata.id}`,
    name: resource.metadata.name,
  };
  const catalog = {
    list: async () => [
      {
        ...executor,
        description: resource.metadata.description,
        origin: "project" as const,
        readOnly: false,
        customized: false,
      },
    ],
    resolve: async (ref: string) => (ref === executor.ref ? executor : undefined),
    validateModelOverride: async () => undefined,
    getModelOptions: async () => ({
      status: "ready" as const,
      runtime: { id: "test", displayName: "Test" },
      models: [],
    }),
  };
  const missions = createMissionStore({ missionsPath: paths.missionsRoot() });
  const knowledge = createContextStoreStore({ storesPath: join(root, "knowledge") });
  const contextStore = await knowledge.create({
    mode: "blank",
    name: "Probe knowledge",
    description: "Isolated",
  });
  const homeProjects = createHomeProjectStore(join(root, "home-projects.json"));
  const preset = await homeProjects.save({
    name: "Probe preset",
    workspace: { path: workspace, basename: "probe" },
    executorRef: executor.ref,
    contextStoreIds: [contextStore.id],
  });
  const creator = createMissionCreator({
    missions,
    project,
    executors: catalog,
    contextStores: knowledge,
    getDefaultToolPermissionMode: () => "request-approval",
  });
  const lifecycle = createLocalHostMissionController({
    missionsPath: paths.missionsRoot(),
    missionPath: missions.storagePath,
    recoverSemanticWrite: async () => undefined,
  });
  const executions = createSqliteExecutionStore({ pragmaHome: root });
  const application = createLocalHostMissionApplication({
    lifecycle,
    client: { surface: "desktop", version: "test", instanceId: crypto.randomUUID() },
    resolveExecutor: async () => undefined,
    assertMission: async (id) => {
      await missions.get(id);
    },
    execution: createDesktopMissionExecutionResources({
      missions,
      project,
      pragmaHome: root,
      runtimes,
      contextStores: knowledge,
      executionStore: executions,
      ownerScope: lifecycle.ownerScope,
      capabilityStore: {} as never,
      capabilityCredentials: {} as never,
      capabilitiesPath: join(root, "capabilities"),
    }),
  });
  const store = createAutomationStore(paths, project.projectId);
  const service = createAutomationService({
    paths,
    project,
    store,
    missions,
    creator,
    application,
    onStorageTrashed,
  });
  const missionPort = createLocalHostPragmaMissionPort({
    missions,
    application,
    creator,
    stateRoot: join(root, "state", "pragma"),
  });
  const automations = createLocalHostPragmaAutomationPort({
    service,
    project,
    stateRoot: join(root, "state", "pragma"),
  });
  const resources = createDesktopPragmaAgentResourceCatalogPort({
    homeProjects,
    contextStores: knowledge,
    executors: catalog,
    workspaceHistory: createWorkspaceHistoryStore({
      historyPath: join(root, "workspace-history.json"),
    }),
    getDefaultWorkspace: async () => workspace,
  });
  return {
    project,
    missions,
    application,
    missionPort,
    automations,
    resources,
    service,
    store,
    executor,
    preset,
    contextStore,
    creator,
    async dispose() {
      service.stop();
      await application.dispose();
      executions.close();
    },
  };
}
