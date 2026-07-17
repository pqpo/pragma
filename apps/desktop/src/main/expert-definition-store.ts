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
  type CreateExpertDefinition,
  type ExpertDefinition,
  type ExpertSummary,
  type UpdateExpertDefinition,
} from "../shared/desktop-api.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import {
  desktopCapabilityBindingRef,
  desktopContextBindingRef,
  desktopModelProviderBindingRef,
  parseDesktopCapabilityBindingRef,
  parseDesktopModelProviderBindingRef,
} from "./desktop-binding-ref.ts";

export interface ExpertDefinitionStore {
  list(): Promise<ExpertSummary[]>;
  get(ref: string): Promise<ExpertDefinition>;
  create(input: CreateExpertDefinition): Promise<ExpertDefinition>;
  update(ref: string, input: UpdateExpertDefinition): Promise<ExpertDefinition>;
  remove(ref: string): Promise<void>;
}

export class ExpertDefinitionStoreError extends Error {
  constructor(
    readonly code: "config_invalid" | "expert_exists" | "expert_not_found",
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
      return snapshot.resources
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
        )
        .toSorted((left, right) => left.name.localeCompare(right.name));
    },
    async get(id) {
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
      const parsed = UpdateExpertDefinitionSchema.parse(input);
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
    async remove(id) {
      const snapshot = await options.project.get();
      const resource = snapshot.resources.find(
        (candidate): candidate is PragmaExpertResource =>
          candidate.kind === "Expert" && canonicalPragmaResourceRef(candidate) === id,
      );
      if (resource === undefined) {
        throw new ExpertDefinitionStoreError("expert_not_found", "The expert no longer exists.");
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
  const runtimeId = `${definition.id}.runtime`;
  const runtimeRef = `runtime-profile:${runtimeId}@${definition.version}`;
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
      ...(definition.model?.runtimeId === "pi"
        ? { binding: desktopModelProviderBindingRef(definition.model.providerId) }
        : {}),
      config: {
        runtimeId: definition.model?.runtimeId ?? "codex",
        ...(definition.model?.modelName === undefined ? {} : { model: definition.model.modelName }),
      },
    },
  });
  const capabilityResources = (definition.capabilities ?? []).map((capability) =>
    PragmaCapabilityResourceSchema.parse({
      apiVersion: "pragma/v2",
      kind: "Capability",
      metadata: {
        id: capability.capabilityId,
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
        id: mount.storeId,
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
          ref: `capability:${capability.capabilityId}@${capability.revision}`,
          kind: capability.kind,
          ...(capability.kind === "tools" ? { tools: capability.toolNames } : {}),
        })),
        ...(definition.opaqueCapabilities ?? []),
      ],
      toolApprovals: definition.toolApprovals ?? {},
      plugins: (definition.plugins ?? []).map((plugin) => ({
        ref: toPluginRef(plugin.source),
        ...(plugin.config === undefined ? {} : { config: plugin.config }),
      })),
      contextStores: (definition.contextStoreMounts ?? []).map((mount) => ({
        ref: `context-store:${mount.storeId}@1.0.0`,
        namespace: `context_${mount.storeId.replaceAll("-", "_")}`,
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
    const referenced = referencedResourceRefs(remaining);
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

function referencedResourceRefs(resources: readonly PragmaResource[]): Set<string> {
  const refs = new Set<string>();
  const addToolRefs = (tools: PragmaExpertResource["spec"]["tools"]) => {
    for (const tool of tools) {
      if (tool.target !== undefined) refs.add(tool.target.ref);
      for (const target of tool.targets ?? []) refs.add(target.ref);
      for (const runtime of Object.values(tool.policy?.runtimes ?? {})) refs.add(runtime);
    }
  };
  for (const resource of resources) {
    if (resource.kind === "Expert") {
      refs.add(resource.spec.runtime.ref);
      for (const capability of resource.spec.capabilities) refs.add(capability.ref);
      for (const context of resource.spec.contextStores) refs.add(context.ref);
      addToolRefs(resource.spec.tools);
      continue;
    }
    if (resource.kind === "ExpertTeam") {
      refs.add(resource.spec.coordinator.ref);
      for (const member of resource.spec.members) refs.add(member.ref);
      for (const runtime of Object.values(resource.spec.delegation.runtimes)) refs.add(runtime);
      continue;
    }
    if (resource.kind === "Flow") {
      for (const step of Object.values(resource.spec.graph.steps)) {
        const target = step.expert ?? step.team ?? step.flow;
        if (target !== undefined) refs.add(target.ref);
        if (step.runtime !== undefined) refs.add(step.runtime);
        for (const runtime of Object.values(step.runtimes ?? {})) refs.add(runtime);
      }
    }
  }
  return refs;
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
    const parsed = parseCapabilityRef(capability.ref);
    const declared = resources.find(
      (candidate) => canonicalPragmaResourceRef(candidate) === capability.ref,
    );
    const desktopBinding =
      declared?.kind === "Capability" &&
      declared.spec.adapter === "pragma.capability.host@v1" &&
      declared.metadata.tags.includes("desktop-managed")
        ? parseDesktopCapabilityBindingRef(declared.spec.binding ?? "")
        : undefined;
    if (
      parsed === undefined ||
      desktopBinding === undefined ||
      desktopBinding.id !== parsed.id ||
      desktopBinding.revision !== parsed.revision
    ) {
      opaqueCapabilities.push(capability);
    } else if (capability.kind === "tools") {
      capabilities.push({
        kind: "tools",
        capabilityId: parsed.id,
        revision: parsed.revision,
        toolNames: capability.tools ?? [],
      });
    } else {
      capabilities.push({ kind: "skill", capabilityId: parsed.id, revision: parsed.revision });
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
    model: desktopModel(resource, resources),
    resourceRuntime: resource.spec.runtime,
    capabilities,
    opaqueCapabilities,
    toolApprovals: resource.spec.toolApprovals,
    plugins: resource.spec.plugins.map((plugin) => ({
      source: plugin.ref,
      ...(plugin.config === undefined ? {} : { config: plugin.config }),
    })),
    contextStoreMounts: resource.spec.contextStores.map((mount) => ({
      storeId: /^context-store:([^@]+)@/.exec(mount.ref)?.[1] ?? mount.namespace,
      enabled: mount.required,
      priority: 0,
    })),
    resourceTools: resource.spec.tools,
    revision: Math.max(1, revision),
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

function parseCapabilityRef(
  ref: string,
): { readonly id: string; readonly revision: number } | undefined {
  const match = /^capability:([^@]+)@(\d+)$/.exec(ref);
  if (match === null) return undefined;
  return { id: match[1]!, revision: Number(match[2]) };
}

function desktopModel(
  resource: PragmaExpertResource,
  resources: readonly PragmaResource[],
): ExpertDefinition["model"] {
  const runtime = resources.find(
    (candidate): candidate is PragmaRuntimeProfileResource =>
      candidate.kind === "RuntimeProfile" &&
      canonicalPragmaResourceRef(candidate) === resource.spec.runtime.ref,
  );
  if (
    runtime === undefined ||
    typeof runtime.spec.config !== "object" ||
    runtime.spec.config === null
  ) {
    return null;
  }
  const config = runtime.spec.config as { runtimeId?: unknown; model?: unknown };
  const runtimeId = typeof config.runtimeId === "string" ? config.runtimeId : undefined;
  const model = typeof config.model === "string" ? config.model : "default";
  const providerId = parseDesktopModelProviderBindingRef(runtime.spec.binding ?? "");
  if (runtimeId === "pi" && providerId !== undefined) {
    return {
      runtimeId: "pi",
      providerId,
      modelName: model,
    };
  }
  if (runtimeId === "codex" || runtimeId === "claude-code") {
    return { runtimeId, modelName: model };
  }
  return null;
}

function toPluginRef(source: string): string {
  if (/^plugin:[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.+_-]*$/.test(source)) {
    return source;
  }
  const id = source.replace(/[^A-Za-z0-9._-]+/g, ".").replace(/^\.+|\.+$/g, "") || "plugin";
  return `plugin:${id}@1.0.0`;
}
