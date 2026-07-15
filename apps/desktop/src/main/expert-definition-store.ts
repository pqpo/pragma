import {
  PragmaExpertResourceSchema,
  type PragmaExpertResource,
  type PragmaResource,
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

export interface ExpertDefinitionStore {
  list(): Promise<ExpertSummary[]>;
  get(id: string): Promise<ExpertDefinition>;
  create(input: CreateExpertDefinition): Promise<ExpertDefinition>;
  update(id: string, input: UpdateExpertDefinition): Promise<ExpertDefinition>;
  remove(id: string): Promise<void>;
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
 * Compatibility view used by the current Desktop expert form. Persistence is exclusively the
 * versioned Pragma YAML project; this adapter does not read or write the removed expert JSON format.
 */
export function createExpertDefinitionStore(options: {
  readonly project: PragmaProjectStore;
}): ExpertDefinitionStore {
  const getResource = async (
    id: string,
  ): Promise<{
    readonly resource: PragmaExpertResource;
    readonly revision: number;
    readonly updatedAt: string;
  }> => {
    const snapshot = await options.project.get();
    const resource = snapshot.resources.find(
      (candidate): candidate is PragmaExpertResource =>
        candidate.kind === "Expert" && candidate.metadata.id === id,
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
            pragmaExpertResourceToDesktopDefinition(resource, snapshot.revision, timestamp),
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
      );
    },
    async create(input) {
      const parsed = CreateExpertDefinitionSchema.parse(input);
      const snapshot = await options.project.get();
      if (
        snapshot.resources.some(
          (resource) => resource.kind === "Expert" && resource.metadata.id === parsed.id,
        )
      ) {
        throw new ExpertDefinitionStoreError(
          "expert_exists",
          `Expert ${parsed.id} already exists.`,
        );
      }
      const updated = await options.project.upsert({
        expectedRevision: snapshot.revision,
        resource: definitionToResource(parsed),
      });
      const resource = updated.resources.find(
        (candidate): candidate is PragmaExpertResource =>
          candidate.kind === "Expert" && candidate.metadata.id === parsed.id,
      )!;
      return pragmaExpertResourceToDesktopDefinition(
        resource,
        updated.revision,
        updated.updatedAt ?? new Date().toISOString(),
      );
    },
    async update(id, input) {
      const parsed = UpdateExpertDefinitionSchema.parse(input);
      const snapshot = await options.project.get();
      const current = snapshot.resources.find(
        (resource): resource is PragmaExpertResource =>
          resource.kind === "Expert" && resource.metadata.id === id,
      );
      if (current === undefined) {
        throw new ExpertDefinitionStoreError("expert_not_found", "The expert no longer exists.");
      }
      const updated = await options.project.upsert({
        expectedRevision: snapshot.revision,
        resource: definitionToResource({ ...parsed, id }, current),
      });
      const resource = updated.resources.find(
        (candidate): candidate is PragmaExpertResource =>
          candidate.kind === "Expert" && candidate.metadata.id === id,
      )!;
      return pragmaExpertResourceToDesktopDefinition(
        resource,
        updated.revision,
        updated.updatedAt ?? new Date().toISOString(),
      );
    },
    async remove(id) {
      const snapshot = await options.project.get();
      const resource = snapshot.resources.find(
        (candidate): candidate is PragmaExpertResource =>
          candidate.kind === "Expert" && candidate.metadata.id === id,
      );
      if (resource === undefined) {
        throw new ExpertDefinitionStoreError("expert_not_found", "The expert no longer exists.");
      }
      await options.project.remove({
        expectedRevision: snapshot.revision,
        ref: `expert:${resource.metadata.id}@${resource.metadata.version}`,
      });
    },
  };
}

function definitionToResource(
  definition: CreateExpertDefinition & { readonly id: string },
  current?: PragmaExpertResource,
): PragmaResource {
  return PragmaExpertResourceSchema.parse({
    apiVersion: "pragma/v1",
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
      runtime:
        definition.model === null || definition.model === undefined
          ? definition.resourceRuntime
          : {
              id: definition.model.runtimeId,
              model: definition.model.modelName,
              ...(definition.model.runtimeId === "pi"
                ? { provider: definition.model.providerId }
                : {}),
            },
      capabilities: [
        ...(definition.capabilities ?? []).map((capability) => ({
          ref: `capability:${capability.capabilityId}@${capability.revision}`,
          kind: capability.kind,
          ...(capability.kind === "tools" ? { tools: capability.toolNames } : {}),
        })),
        ...(definition.opaqueCapabilities ?? []),
      ],
      toolApprovals: definition.toolApprovals ?? {},
      plugins: definition.plugins ?? [],
      contextStores: (definition.contextStoreMounts ?? []).map((mount) => ({
        ref: `context:${mount.storeId}`,
        enabled: mount.enabled,
        priority: mount.priority,
      })),
      tools: definition.resourceTools ?? current?.spec.tools ?? [],
    },
  });
}

export function pragmaExpertResourceToDesktopDefinition(
  resource: PragmaExpertResource,
  revision: number,
  timestamp: string,
): ExpertDefinition {
  const capabilities: ExpertDefinition["capabilities"] = [];
  const opaqueCapabilities: PragmaExpertResource["spec"]["capabilities"] = [];
  for (const capability of resource.spec.capabilities) {
    const parsed = parseCapabilityRef(capability.ref);
    if (parsed === undefined) {
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
    id: resource.metadata.id,
    name: resource.metadata.name,
    description: resource.metadata.description,
    tags: resource.metadata.tags,
    version: resource.metadata.version,
    scope: resource.spec.scope,
    instructions: resource.spec.instructions,
    model: desktopModel(resource),
    resourceRuntime: isDesktopRuntime(resource) ? undefined : resource.spec.runtime,
    capabilities,
    opaqueCapabilities,
    toolApprovals: resource.spec.toolApprovals,
    plugins: resource.spec.plugins,
    contextStoreMounts: resource.spec.contextStores.map((mount) => ({
      storeId: mount.ref.replace(/^context:/, ""),
      enabled: mount.enabled,
      priority: mount.priority,
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

function isDesktopRuntime(resource: PragmaExpertResource): boolean {
  const runtime = resource.spec.runtime;
  return (
    runtime === undefined ||
    (runtime.id === "pi" && runtime.provider !== undefined) ||
    runtime.id === "codex" ||
    runtime.id === "claude-code"
  );
}

function desktopModel(resource: PragmaExpertResource): ExpertDefinition["model"] {
  const runtime = resource.spec.runtime;
  if (runtime === undefined) return null;
  if (runtime.id === "pi" && runtime.provider !== undefined) {
    return {
      runtimeId: "pi",
      providerId: runtime.provider,
      modelName: runtime.model ?? "default",
    };
  }
  if (runtime.id === "codex" || runtime.id === "claude-code") {
    return { runtimeId: runtime.id, modelName: runtime.model ?? "default" };
  }
  return null;
}
