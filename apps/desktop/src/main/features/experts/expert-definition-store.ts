import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaExpertResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaResource,
  type PragmaRuntimeProfileResource,
} from "@pragma/interpreter/ast";
import { generatePragmaResourceId } from "@pragma/core";
import { DEFAULT_PRAGMA_EXPERT_AVATAR_ID } from "@pragma/shared";

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
} from "../../../shared/contracts/index.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";
import type { DesktopSystemExpertRegistry } from "./system-expert-registry.ts";
import { parseDesktopModelProviderBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";
import {
  classifyDesktopCapabilityResource,
  classifyDesktopContextResource,
  resolveDesktopCapabilityResource,
  resolveDesktopContextResource,
  resolveDesktopRuntimeResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import {
  referencedPragmaResourceRefs,
  referencingPragmaResources,
} from "../projects/pragma-resource-references.ts";

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

type ExpertDefinitionWrite = Omit<UpdateExpertDefinition, "baseRevision">;

/**
 * Form projection used by the current Desktop expert editor. Persistence is exclusively the
 * Pragma YAML project; this adapter does not read or write a parallel expert format.
 */
export function createExpertDefinitionStore(options: {
  readonly project: PragmaProjectStore;
  readonly systemExperts: DesktopSystemExpertRegistry;
  readonly validateModel: (model: CreateExpertDefinition["model"]) => Promise<void>;
  readonly onRemoved?: ((expertRef: string) => Promise<void>) | undefined;
}): ExpertDefinitionStore {
  const getResource = async (
    ref: string,
  ): Promise<{
    readonly resource: PragmaExpertResource;
    readonly revision: number;
    readonly updatedAt: string;
    readonly resources: readonly PragmaResource[];
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
      resources: snapshot.resources,
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
        found.resources,
      );
    },
    async create(input) {
      const parsed = CreateExpertDefinitionSchema.parse(input);
      await options.validateModel(parsed.model);
      const snapshot = await options.project.get();
      const id = allocateExpertId(snapshot.resources, options.systemExperts);
      const requestedRef = `expert:${id}`;
      const { baseRevision, requiredUnchangedRefs, ...definition } = parsed;
      const definitions = definitionToResources(definition, id, snapshot.resources);
      const updated = await options.project.apply({
        baseRevision,
        upserts: definitions,
        requiredUnchangedRefs,
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
      const { baseRevision, ...definition } = parsed;
      const snapshot = await options.project.get();
      const current = snapshot.resources.find(
        (resource): resource is PragmaExpertResource =>
          resource.kind === "Expert" && canonicalPragmaResourceRef(resource) === id,
      );
      if (current === undefined) {
        throw new ExpertDefinitionStoreError("expert_not_found", "The expert no longer exists.");
      }
      const definitions = definitionToResources(
        definition,
        current.metadata.id,
        snapshot.resources,
        current,
      );
      const nextExpert = definitions.find(
        (resource): resource is PragmaExpertResource => resource.kind === "Expert",
      )!;
      const nextRef = canonicalPragmaResourceRef(nextExpert);
      const replacedRefs = new Set([canonicalPragmaResourceRef(current)]);
      const previousDependencyRefs = referencedPragmaResourceRefs([current]);
      const nextResources = mergeResources(
        snapshot.resources.filter(
          (resource) => !replacedRefs.has(canonicalPragmaResourceRef(resource)),
        ),
        definitions,
      );
      const nextReferencedRefs = referencedPragmaResourceRefs(nextResources);
      const updated = await options.project.apply({
        baseRevision,
        upserts: definitions,
        removals: [
          ...snapshot.resources
            .filter(
              (resource) =>
                isDesktopManagedDependency(resource) &&
                previousDependencyRefs.has(canonicalPragmaResourceRef(resource)) &&
                !nextReferencedRefs.has(canonicalPragmaResourceRef(resource)),
            )
            .map(canonicalPragmaResourceRef),
        ],
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
      const retainedResources = pruneUnreferencedDesktopResources(
        snapshot.resources.filter(
          (candidate) =>
            canonicalPragmaResourceRef(candidate) !== canonicalPragmaResourceRef(resource),
        ),
      );
      const retainedRefs = new Set(retainedResources.map(canonicalPragmaResourceRef));
      await options.project.apply({
        baseRevision: snapshot.revision,
        removals: snapshot.resources
          .map(canonicalPragmaResourceRef)
          .filter((ref) => !retainedRefs.has(ref)),
      });
      await options.onRemoved?.(id);
    },
  };
}

function definitionToResources(
  definition: ExpertDefinitionWrite,
  expertId: string,
  existingResources: readonly PragmaResource[],
  current?: PragmaExpertResource,
): PragmaResource[] {
  const selectedModel = definition.model;
  const runtime = resolveDesktopRuntimeResource({
    ownerId: expertId,
    ownerName: definition.name,
    model: selectedModel,
    resources: existingResources,
    currentRef: current?.spec.runtime?.ref,
  });
  const runtimeRef = canonicalPragmaResourceRef(runtime);
  const capabilitySelections = (definition.capabilities ?? []).map((capability) => ({
    capability,
    resource: resolveDesktopCapabilityResource({
      capabilityId: capability.capabilityId,
      revision: capability.revision,
      resources: existingResources,
      currentRef: current?.spec.capabilities.find((reference) => {
        if (reference.kind !== capability.kind) return false;
        const resource = existingResources.find(
          (candidate) => canonicalPragmaResourceRef(candidate) === reference.ref,
        );
        const binding = classifyDesktopCapabilityResource(resource);
        return binding?.id === capability.capabilityId;
      })?.ref,
    }),
  }));
  const capabilityResources = capabilitySelections.map(({ resource }) => resource);
  const contextSelections = (definition.contextStoreMounts ?? []).map((mount) => ({
    mount,
    resource: resolveDesktopContextResource({
      storeId: mount.storeId,
      resources: existingResources,
      currentRef: current?.spec.contextStores.find((reference) => {
        const resource = existingResources.find(
          (candidate) => canonicalPragmaResourceRef(candidate) === reference.ref,
        );
        return classifyDesktopContextResource(resource) === mount.storeId;
      })?.ref,
    }),
  }));
  const contextResources = contextSelections.map(({ resource }) => resource);
  const expert = PragmaExpertResourceSchema.parse({
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: expertId,
      avatarId:
        definition.avatarId ?? current?.metadata.avatarId ?? DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
      name: definition.name,
      description: definition.description,
      tags: definition.tags,
    },
    spec: {
      scope: definition.scope,
      instructions: definition.instructions,
      runtime: { ref: runtimeRef },
      capabilities: [
        ...capabilitySelections.map(({ capability, resource }) => ({
          ref: canonicalPragmaResourceRef(resource),
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
      contextStores: [
        ...contextSelections.map(({ mount, resource }) => ({
          ref: canonicalPragmaResourceRef(resource),
          namespace: resource.metadata.id,
          required: mount.enabled,
        })),
        ...(definition.opaqueContextStores ?? []),
      ],
      tools: definition.resourceTools ?? current?.spec.tools ?? [],
    },
  });
  return [runtime, ...capabilityResources, ...contextResources, expert].filter(
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
        ? classifyDesktopCapabilityResource(declared)
        : undefined;
    if (desktopBinding === undefined) {
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
  const contextStoreMounts: ExpertDefinition["contextStoreMounts"] = [];
  const opaqueContextStores: PragmaExpertResource["spec"]["contextStores"] = [];
  for (const mount of resource.spec.contextStores) {
    const declared = resources.find(
      (candidate) => canonicalPragmaResourceRef(candidate) === mount.ref,
    );
    const storeId =
      declared?.kind === "ContextStore" &&
      declared.spec.adapter === "pragma.context.host@v1" &&
      declared.metadata.tags.includes("desktop-managed")
        ? classifyDesktopContextResource(declared)
        : undefined;
    if (storeId === undefined) {
      opaqueContextStores.push(mount);
    } else {
      contextStoreMounts.push({ storeId, enabled: mount.required, priority: 0 });
    }
  }
  return ExpertDefinitionSchema.parse({
    schemaVersion: "pragma.desktop-expert-view/v1",
    ref: canonicalPragmaResourceRef(resource),
    id: resource.metadata.id,
    avatarId: resource.metadata.avatarId,
    name: resource.metadata.name,
    description: resource.metadata.description,
    tags: resource.metadata.tags,
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
    opaqueContextStores,
    toolApprovals: resource.spec.toolApprovals,
    plugins: resource.spec.plugins.map((plugin) => ({
      ref: plugin.ref,
      ...(plugin.config === undefined ? {} : { config: plugin.config }),
      ...(plugin.secretBindings === undefined ? {} : { secretBindings: plugin.secretBindings }),
    })),
    contextStoreMounts,
    resourceTools: resource.spec.tools,
    revision: Math.max(1, revision),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function allocateExpertId(
  resources: readonly PragmaResource[],
  systemExperts: DesktopSystemExpertRegistry,
): string {
  const used = new Set(resources.map((resource) => resource.metadata.id));
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const candidate = generatePragmaResourceId();
    if (!used.has(candidate) && !systemExperts.isReservedId(candidate)) return candidate;
  }
  throw new ExpertDefinitionStoreError("expert_exists", "Could not allocate a unique Expert ID.");
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
