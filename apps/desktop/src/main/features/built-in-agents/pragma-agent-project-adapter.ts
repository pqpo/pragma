import {
  createLocalHostPragmaProjectPort,
  type PragmaManagementExpertCatalog,
} from "@pragma/local-host";
import {
  PragmaAgentExpertOptionCatalogSchema,
  type PragmaAgentDslProjectPort,
} from "@pragma/built-in-agents";
import { canonicalPragmaResourceRef, type PragmaResource } from "@pragma/interpreter/ast";
import { BUILT_IN_PRAGMA_EXPERT_AVATAR_PROFILES } from "@pragma/shared";
import type { Capability } from "../../../shared/contracts/index.ts";
import { parseDesktopCapabilityBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";
import {
  createDesktopCapabilityResource,
  createDesktopRuntimeOptionResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { listCapabilitiesWithBuiltIns } from "../capabilities/built-in-capabilities.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import { getRuntimeAvailability } from "../runtimes/runtime-availability.ts";
import type { RuntimeEnvironmentService } from "../runtimes/runtime-environment-service.ts";
import type { DesktopSystemExpertRegistry } from "../experts/system-expert-registry.ts";
import { ensurePragmaWorkspaceGitExclude } from "../capabilities/skill-revision-workspace.ts";

export function createDesktopPragmaAgentProjectPort(options: {
  readonly project: PragmaProjectStore;
  readonly stateRoot: string;
  readonly withMissionMutation?:
    (<T>(id: string, action: () => Promise<T>) => Promise<T>) | undefined;
  readonly assertMissionWritable?: ((id: string) => Promise<void>) | undefined;
  readonly draftsRoot?: string | undefined;
  readonly draftsTrashRoot?: string | undefined;
  readonly capabilities: CapabilityStore;
  readonly runtimes: RuntimeEnvironmentService;
  readonly systemExperts: Pick<DesktopSystemExpertRegistry, "list" | "get" | "getResource">;
}): PragmaAgentDslProjectPort {
  return createLocalHostPragmaProjectPort({
    ...options,
    catalog: () => buildExpertCatalog(options),
    readSystemResource: (ref) => options.systemExperts.getResource(ref),
    prepareWorkspace: ensurePragmaWorkspaceGitExclude,
  });
}

async function buildExpertCatalog(options: {
  readonly capabilities: CapabilityStore;
  readonly runtimes: RuntimeEnvironmentService;
  readonly systemExperts: Pick<DesktopSystemExpertRegistry, "list" | "get">;
}): Promise<PragmaManagementExpertCatalog> {
  const [availability, latestCapabilities] = await Promise.all([
    getRuntimeAvailability(options.runtimes),
    listCapabilitiesWithBuiltIns(options.capabilities),
  ]);
  const capabilities = (
    await Promise.all(
      latestCapabilities.map(async (capability) => {
        if (capability.managedBy === "system") return capability;
        return await options.capabilities
          .resolveActive(capability.manifest.id)
          .catch(() => undefined);
      }),
    )
  ).filter((capability): capability is Capability => capability !== undefined);
  const resources = new Map<string, PragmaResource>();
  const runtimeModels = availability
    .filter((runtime) => runtime.status === "available")
    .flatMap((runtime) =>
      (runtime.models ?? []).map((model) => {
        const resource = createDesktopRuntimeOptionResource({
          runtimeId: runtime.id,
          providerId: model.provider.id,
          modelId: model.id,
          name: `${runtime.displayName} / ${model.displayName}`,
          description: `Host-provided Runtime model ${model.provider.displayName} / ${model.displayName}.`,
        });
        const ref = canonicalPragmaResourceRef(resource);
        resources.set(ref, resource);
        return {
          key: ref,
          runtimeProfileRef: ref,
          runtimeName: runtime.displayName,
          providerName: model.provider.displayName,
          modelName: model.displayName,
          isDefault: runtime.isDefault && model.default === true,
        };
      }),
    );
  const capabilityOptions = capabilities.map((capability) => {
    const resource = capabilityResource(capability);
    const ref = canonicalPragmaResourceRef(resource);
    resources.set(ref, resource);
    const toolNames = capabilityToolNames(capability);
    return {
      key: ref,
      ref,
      name: capability.definition.name,
      description: capabilityDescription(capability),
      kind: capability.definition.kind === "skill" ? ("skill" as const) : ("tools" as const),
      toolNames,
    };
  });
  return {
    options: PragmaAgentExpertOptionCatalogSchema.parse({
      runtimeModels,
      capabilities: capabilityOptions,
      avatars: BUILT_IN_PRAGMA_EXPERT_AVATAR_PROFILES,
      builtinExperts: options.systemExperts.list().map((summary) => {
        const definition = options.systemExperts.get(summary.ref);
        if (definition === undefined) {
          throw new Error(`Built-in Expert definition not found: ${summary.ref}`);
        }
        return {
          ref: summary.ref,
          name: summary.name,
          description: summary.description,
          model:
            definition.executionProfile.mode === "system-default"
              ? { mode: "system-default" as const }
              : { mode: "pinned" as const, ...definition.executionProfile.model },
          assignableAs: ["team-member", "coordinator"] as const,
          origin: "system" as const,
          readOnly: true as const,
        };
      }),
    }),
    resources,
    availableModels: new Set(
      availability
        .filter((runtime) => runtime.status === "available")
        .flatMap((runtime) =>
          (runtime.models ?? []).map((model) =>
            runtimeModelIdentity(runtime.id, model.provider.id, model.id),
          ),
        ),
    ),
    isCapabilityAvailable(resource) {
      const binding =
        resource.kind === "Capability"
          ? parseDesktopCapabilityBindingRef(resource.spec.binding ?? "")
          : undefined;
      return (
        binding === undefined ||
        capabilities.some((capability) => capability.manifest.id === binding)
      );
    },
  };
}

function capabilityResource(capability: Capability): PragmaResource {
  return createDesktopCapabilityResource({
    owner: "default-agent-option",
    capabilityId: capability.manifest.id,
    name: capability.definition.name,
    description: capabilityDescription(capability),
  });
}

function capabilityDescription(capability: Capability): string {
  const description = capability.definition.description.trim();
  return description === ""
    ? `Host-provided Desktop capability ${capability.definition.name}.`
    : description;
}

function capabilityToolNames(capability: Capability): string[] {
  switch (capability.definition.kind) {
    case "skill":
      return [];
    case "code_service":
      return [capability.definition.tool.name];
    case "mcp_server":
    case "http_service":
      return capability.definition.tools.map((tool) => tool.name);
  }
}

function runtimeModelIdentity(runtimeId: string, providerId: string, modelId: string): string {
  return JSON.stringify([runtimeId, providerId, modelId]);
}
