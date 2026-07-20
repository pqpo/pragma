import {
  PragmaExpertResourceSchema,
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaRuntimeProfileResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaResource,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";

import {
  CreateExpertDefinitionSchema,
  ExpertDefinitionSchema,
  ExpertSummarySchema,
  UpdateExpertDefinitionSchema,
  UpdateBuiltInExpertDefinitionSchema,
  type CreateExpertDefinition,
  type ExpertDefinition,
  type ExpertSummary,
  type UpdateExpertDefinition,
  type UpdateBuiltInExpertDefinition,
} from "../shared/desktop-api.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "./system-expert-registry.ts";
import {
  desktopCapabilityBindingRef,
  desktopContextBindingRef,
  parseDesktopCapabilityBindingRef,
  parseDesktopContextBindingRef,
  parseDesktopModelProviderBindingRef,
} from "./desktop-binding-ref.ts";
import {
  referencedPragmaResourceRefs,
  referencingPragmaResources,
} from "./pragma-resource-references.ts";

export interface ExpertDefinitionStore {
  list(): Promise<ExpertSummary[]>;
  get(ref: string): Promise<ExpertDefinition>;
  create(input: CreateExpertDefinition): Promise<ExpertDefinition>;
  update(ref: string, input: UpdateExpertDefinition): Promise<ExpertDefinition>;
  updateBuiltIn(ref: string, input: UpdateBuiltInExpertDefinition): Promise<ExpertDefinition>;
  resetBuiltIn(ref: string): Promise<ExpertDefinition>;
  remove(ref: string): Promise<void>;
}

export class ExpertDefinitionStoreError extends Error {
  constructor(
    readonly code:
      | "config_invalid"
      | "expert_exists"
      | "expert_not_found"
      | "expert_referenced"
      | "built_in_readonly",
    message: string,
  ) {
    super(message);
    this.name = "ExpertDefinitionStoreError";
  }
}

/**
 * Form projection used by the current Desktop expert editor. Persistence is exclusively the
 * versioned Pragma YAML project; this adapter does not read or write a parallel expert format.
 */
export function createExpertDefinitionStore(options: {
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly validateModel: (model: CreateExpertDefinition["model"]) => Promise<void>;
}): ExpertDefinitionStore {
  const getResource = async (
    ref: string,
  ): Promise<{
    readonly resource: PragmaExpertResource;
    readonly revision: number;
    readonly updatedAt: string;
  }> => {
    const snapshot = await options.project.get();
    const resource = snapshot.resources.find(
      (candidate): candidate is PragmaExpertResource =>
        candidate.kind === "Expert" && canonicalPragmaResourceRef(candidate) === ref,
    );
    if (resource === undefined) {
      throw new ExpertDefinitionStoreError("expert_not_found", "The expert no longer exists.");
    }
    return {
      resource,
      revision: snapshot.revision,
      updatedAt: snapshot.updatedAt ?? new Date(0).toISOString(),
    };
  };

  return {
    async list() {
      const snapshot = await options.project.get();
      const timestamp = snapshot.updatedAt ?? new Date(0).toISOString();
      const projectExperts = snapshot.resources
        .filter((resource): resource is PragmaExpertResource => resource.kind === "Expert")
        .map((resource) =>
          ExpertSummarySchema.parse(
            pragmaExpertResourceToDesktopDefinition(
              resource,
              snapshot.revision,
              timestamp,
              snapshot.resources,
            ),
          ),
        );
      return [...options.systemExperts.list(), ...projectExperts].toSorted((left, right) =>
        left.name.localeCompare(right.name),
      );
    },
    async get(id) {
      const system = options.systemExperts.get(id);
      if (system !== undefined) return system;
      const found = await getResource(id);
      return pragmaExpertResourceToDesktopDefinition(
        found.resource,
        found.revision,
        found.updatedAt,
        (await options.project.get()).resources,
      );
    },
    async create(input) {
      const parsed = CreateExpertDefinitionSchema.parse(input);
      if (options.systemExperts.isReservedId(parsed.id)) {
        throw new ExpertDefinitionStoreError(
          "built_in_readonly",
          `Expert ID ${parsed.id} is reserved by a built-in Expert.`,
        );
      }
      await options.validateModel(parsed.model);
      const snapshot = await options.project.get();
      const requestedRef = `expert:${parsed.id}@${parsed.version}`;
      if (
        snapshot.resources.some(
          (resource) =>
            resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === requestedRef,
        )
      ) {
        throw new ExpertDefinitionStoreError(
          "expert_exists",
          `Expert ${parsed.id} already exists.`,
        );
      }
      const definitions = definitionToResources(parsed);
      const updated = await options.project.publish({
        expectedRevision: snapshot.revision,
        resources: mergeResources(snapshot.resources, definitions),
      });
      const resource = updated.resources.find(
        (candidate): candidate is PragmaExpertResource =>
          candidate.kind === "Expert" && canonicalPragmaResourceRef(candidate) === requestedRef,
      )!;
      return pragmaExpertResourceToDesktopDefinition(
        resource,
        updated.revision,
        updated.updatedAt ?? new Date().toISOString(),
        updated.resources,
      );
    },
    async update(id, input) {
      if (options.systemExperts.isReservedRef(id)) {
        throw new ExpertDefinitionStoreError(
          "built_in_readonly",
          "Built-in Experts cannot be modified.",
        );
      }
      const parsed = UpdateExpertDefinitionSchema.parse(input);
      await options.validateModel(parsed.model);
      const snapshot = await options.project.get();
      const current = snapshot.resources.find(
        (resource): resource is PragmaExpertResource =>
          resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === id,
      );
      if (current === undefined) {
        throw new ExpertDefinitionStoreError("expert_not_found", "The expert no longer exists.");
      }
      const definitions = definitionToResources({ ...parsed, id: current.metadata.id }, current);
      const nextExpert = definitions.find(
        (resource): resource is PragmaExpertResource => resource.kind === "Expert",
      )!;
      const nextRef = canonicalPragmaResourceRef(nextExpert);
      if (
        nextRef !== id &&
        snapshot.resources.some((resource) => canonicalPragmaResourceRef(resource) === nextRef)
      ) {
        throw new ExpertDefinitionStoreError("expert_exists", `Expert ${nextRef} already exists.`);
      }
      const replacedRefs = new Set([canonicalPragmaResourceRef(current)]);
      const updated = await options.project.publish({
        expectedRevision: snapshot.revision,
        resources: pruneUnreferencedDesktopResources(
          mergeResources(
            snapshot.resources.filter(
              (resource) => !replacedRefs.has(canonicalPragmaResourceRef(resource)),
            ),
            definitions,
          ),
        ),
      });
      const resource = updated.resources.find(
        (candidate): candidate is PragmaExpertResource =>
          candidate.kind === "Expert" && canonicalPragmaResourceRef(candidate) === nextRef,
      )!;
      return pragmaExpertResourceToDesktopDefinition(
        resource,
        updated.revision,
        updated.updatedAt ?? new Date().toISOString(),
        updated.resources,
      );
    },
    async updateBuiltIn(id, input) {
      const parsed = UpdateBuiltInExpertDefinitionSchema.parse(input);
      if (parsed.model !== undefined) await options.validateModel(parsed.model);
      return await options.systemExperts.update(id, parsed);
    },
    async resetBuiltIn(id) {
      return await options.systemExperts.reset(id);
    },
    async remove(id) {
      if (options.systemExperts.isReservedRef(id)) {
        throw new ExpertDefinitionStoreError(
          "built_in_readonly",
          "Built-in Experts cannot be deleted.",
        );
      }
      const snapshot = await options.project.get();
      const resource = snapshot.resources.find(
        (candidate): candidate is PragmaExpertResource =>
          candidate.kind === "Expert" && canonicalPragmaResourceRef(candidate) === id,
      );
      if (resource === undefined) {
        throw new ExpertDefinitionStoreError("expert_not_found", "The expert no longer exists.");
      }
      if (referencingPragmaResources(snapshot.resources, id).length > 0) {
        throw new ExpertDefinitionStoreError(
          "expert_referenced",
          "This Expert is used by an Expert Team, Flow, or resource tool. Remove those dependencies before deleting it.",
        );
      }
      await options.project.publish({
        expectedRevision: snapshot.revision,
        resources: pruneUnreferencedDesktopResources(
          snapshot.resources.filter(
            (candidate) =>
              canonicalPragmaResourceRef(candidate) !== canonicalPragmaResourceRef(resource),
          ),
        ),
      });
    },
  };
}

function definitionToResources(
  definition: CreateExpertDefinition & { readonly id: string },
  current?: PragmaExpertResource,
): PragmaResource[] {
  const runtimeId = `${definition.id}_runtime`;
  const runtimeRef = `runtime-profile:${runtimeId}@${definition.version}`;
  const selectedModel = definition.model;
  const runtime = PragmaRuntimeProfileResourceSchema.parse({
    apiVersion: "pragma/v2",
    kind: "RuntimeProfile",
    metadata: {
      id: runtimeId,
      version: definition.version,
      name: `${definition.name} Runtime`,
      description: `Runtime profile for ${definition.name}.`,
      tags: ["desktop-managed"],
    },
    spec: {
      adapter: "pragma.runtime.profile@v1",
      config: {
        runtimeId: selectedModel.runtimeId,
        providerId: selectedModel.providerId,
        model: selectedModel.modelId,
        ...(selectedModel.thinkingLevel === undefined
          ? {}
          : { thinkingLevel: selectedModel.thinkingLevel }),
      },
    },
  });
  const capabilityResources = (definition.capabilities ?? []).map((capability) =>
    PragmaCapabilityResourceSchema.parse({
      apiVersion: "pragma/v2",
      kind: "Capability",
      metadata: {
        id: desktopCapabilityResourceId(capability.capabilityId),
        version: String(capability.revision),
        name: `Capability ${capability.capabilityId}`,
        description: "Desktop-managed capability binding.",
        tags: ["desktop-managed"],
      },
      spec: {
        adapter: "pragma.capability.host@v1",
        binding: desktopCapabilityBindingRef(capability.capabilityId, capability.revision),
        config: { key: capability.capabilityId },
      },
    }),
  );
  const contextResources = (definition.contextStoreMounts ?? []).map((mount) =>
    PragmaContextStoreResourceSchema.parse({
      apiVersion: "pragma/v2",
      kind: "ContextStore",
      metadata: {
        id: desktopContextResourceId(mount.storeId),
        version: "1.0.0",
        name: `Context ${mount.storeId}`,
        description: "Desktop-managed context store binding.",
        tags: ["desktop-managed"],
      },
      spec: {
        adapter: "pragma.context.host@v1",
        binding: desktopContextBindingRef(mount.storeId),
        config: { key: mount.storeId },
      },
    }),
  );
  const expert = PragmaExpertResourceSchema.parse({
    apiVersion: "pragma/v2",
    kind: "Expert",
    metadata: {
      id: definition.id,
      version: definition.version,
      name: definition.name,
      description: definition.description,
      tags: definition.tags,
    },
    spec: {
      scope: definition.scope,
      instructions: definition.instructions,
      runtime: { ref: runtimeRef },
      capabilities: [
        ...(definition.capabilities ?? []).map((capability) => ({
          ref: `capability:${desktopCapabilityResourceId(capability.capabilityId)}@${capability.revision}`,
          kind: capability.kind,
          ...(capability.kind === "tools" ? { tools: capability.toolNames } : {}),
        })),
        ...(definition.opaqueCapabilities ?? []),
      ],
      toolApprovals: definition.toolApprovals ?? {},
      plugins: (definition.plugins ?? []).map((plugin) => ({
        ref: plugin.ref,
        ...(plugin.config === undefined ? {} : { config: plugin.config }),
        ...(plugin.secretBindings === undefined ? {} : { secretBindings: plugin.secretBindings }),
      })),
      contextStores: (definition.contextStoreMounts ?? []).map((mount) => ({
        ref: `context-store:${desktopContextResourceId(mount.storeId)}@1.0.0`,
        namespace: desktopContextResourceId(mount.storeId),
        required: mount.enabled,
      })),
      tools: definition.resourceTools ?? current?.spec.tools ?? [],
    },
  });
  return [
    runtime,
    ...capabilityResources.filter(
      (resource, index, all) =>
        all.findIndex(
          (candidate) =>
            canonicalPragmaResourceRef(candidate) === canonicalPragmaResourceRef(resource),
        ) === index,
    ),
    ...contextResources.filter(
      (resource, index, all) =>
        all.findIndex(
          (candidate) =>
            canonicalPragmaResourceRef(candidate) === canonicalPragmaResourceRef(resource),
        ) === index,
    ),
    expert,
  ].filter(
    (resource, index, all) =>
      all.findIndex(
        (candidate) =>
          canonicalPragmaResourceRef(candidate) === canonicalPragmaResourceRef(resource),
      ) === index,
  );
}

function mergeResources(
  existing: readonly PragmaResource[],
  replacements: readonly PragmaResource[],
): PragmaResource[] {
  const byRef = new Map(
    existing.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  for (const resource of replacements) byRef.set(canonicalPragmaResourceRef(resource), resource);
  return [...byRef.values()];
}

function pruneUnreferencedDesktopResources(resources: readonly PragmaResource[]): PragmaResource[] {
  let remaining = [...resources];
  for (;;) {
    const referenced = referencedPragmaResourceRefs(remaining);
    const next = remaining.filter(
      (resource) =>
        !(
          isDesktopManagedDependency(resource) &&
          !referenced.has(canonicalPragmaResourceRef(resource))
        ),
    );
    if (next.length === remaining.length) return next;
    remaining = next;
  }
}

function isDesktopManagedDependency(resource: PragmaResource): boolean {
  return (
    (resource.kind === "RuntimeProfile" ||
      resource.kind === "Capability" ||
      resource.kind === "ContextStore") &&
    resource.metadata.tags.includes("desktop-managed")
  );
}

export function pragmaExpertResourceToDesktopDefinition(
  resource: PragmaExpertResource,
  revision: number,
  timestamp: string,
  resources: readonly PragmaResource[] = [],
): ExpertDefinition {
  const capabilities: ExpertDefinition["capabilities"] = [];
  const opaqueCapabilities: PragmaExpertResource["spec"]["capabilities"] = [];
  for (const capability of resource.spec.capabilities) {
    const declared = resources.find(
      (candidate) => canonicalPragmaResourceRef(candidate) === capability.ref,
    );
    const desktopBinding =
      declared?.kind === "Capability" &&
      declared.spec.adapter === "pragma.capability.host@v1" &&
      declared.metadata.tags.includes("desktop-managed")
        ? parseDesktopCapabilityBindingRef(declared.spec.binding ?? "")
        : undefined;
    if (desktopBinding === undefined || !capability.ref.endsWith(`@${desktopBinding.revision}`)) {
      opaqueCapabilities.push(capability);
    } else if (capability.kind === "tools") {
      capabilities.push({
        kind: "tools",
        capabilityId: desktopBinding.id,
        revision: desktopBinding.revision,
        toolNames: capability.tools ?? [],
      });
    } else {
      capabilities.push({
        kind: "skill",
        capabilityId: desktopBinding.id,
        revision: desktopBinding.revision,
      });
    }
  }
  return ExpertDefinitionSchema.parse({
    schemaVersion: "pragma.desktop-expert-view/v1",
    ref: canonicalPragmaResourceRef(resource),
    id: resource.metadata.id,
    name: resource.metadata.name,
    description: resource.metadata.description,
    tags: resource.metadata.tags,
    version: resource.metadata.version,
    scope: resource.spec.scope,
    instructions: resource.spec.instructions,
    additionalInstructions: "",
    origin: "project",
    readOnly: false,
    customized: false,
    executionProfile: { mode: "pinned", model: desktopModel(resource, resources) },
    resourceRuntime: resource.spec.runtime,
    capabilities,
    opaqueCapabilities,
    toolApprovals: resource.spec.toolApprovals,
    plugins: resource.spec.plugins.map((plugin) => ({
      ref: plugin.ref,
      ...(plugin.config === undefined ? {} : { config: plugin.config }),
      ...(plugin.secretBindings === undefined ? {} : { secretBindings: plugin.secretBindings }),
    })),
    contextStoreMounts: resource.spec.contextStores.map((mount) => {
      const declared = resources.find(
        (candidate) => canonicalPragmaResourceRef(candidate) === mount.ref,
      );
      const storeId =
        declared?.kind === "ContextStore"
          ? parseDesktopContextBindingRef(declared.spec.binding ?? "")
          : undefined;
      return {
        storeId: storeId ?? mount.namespace,
        enabled: mount.required,
        priority: 0,
      };
    }),
    resourceTools: resource.spec.tools,
    revision: Math.max(1, revision),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function desktopCapabilityResourceId(id: string): string {
  return `capability_${id.replaceAll("-", "")}`;
}

function desktopContextResourceId(id: string): string {
  return `context_${id.replaceAll("-", "")}`;
}

function desktopModel(
  resource: PragmaExpertResource,
  resources: readonly PragmaResource[],
): CreateExpertDefinition["model"] {
  if (resource.spec.runtime === undefined) {
    throw new ExpertDefinitionStoreError(
      "config_invalid",
      `Expert ${resource.metadata.id} does not declare a Runtime profile.`,
    );
  }
  const runtimeRef = resource.spec.runtime.ref;
  const runtime = resources.find(
    (candidate): candidate is PragmaRuntimeProfileResource =>
      candidate.kind === "RuntimeProfile" && canonicalPragmaResourceRef(candidate) === runtimeRef,
  );
  if (
    runtime === undefined ||
    typeof runtime.spec.config !== "object" ||
    runtime.spec.config === null
  ) {
    throw new ExpertDefinitionStoreError(
      "config_invalid",
      `Expert ${resource.metadata.id} references an invalid Runtime profile.`,
    );
  }
  const config = runtime.spec.config as {
    runtimeId?: unknown;
    providerId?: unknown;
    model?: unknown;
    thinkingLevel?: unknown;
  };
  const runtimeId = typeof config.runtimeId === "string" ? config.runtimeId : undefined;
  const model = typeof config.model === "string" ? config.model : undefined;
  const thinkingLevel = typeof config.thinkingLevel === "string" ? config.thinkingLevel : undefined;
  const providerId =
    typeof config.providerId === "string"
      ? config.providerId
      : parseDesktopModelProviderBindingRef(runtime.spec.binding ?? "");
  if (runtimeId !== undefined && providerId !== undefined && model !== undefined) {
    return {
      runtimeId,
      providerId,
      modelId: model,
      ...(thinkingLevel === undefined ? {} : { thinkingLevel }),
    };
  }
  throw new ExpertDefinitionStoreError(
    "config_invalid",
    `Expert ${resource.metadata.id} does not declare a usable Runtime model.`,
  );
}
