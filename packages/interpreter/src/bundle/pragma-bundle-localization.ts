import {
  PragmaResourceSchema,
  type PragmaResource,
  type PragmaResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import type { PragmaBundleManifest, PragmaBundleRequirement } from "../ast/pragma-bundle.schema.ts";
import { canonicalPragmaResourceRef } from "../ast/resource-identity.ts";

export interface PragmaBundleIdentityLocalization {
  readonly sourceRef: PragmaResourceRef;
  readonly targetId: string;
  readonly targetName?: string | undefined;
}

export type PragmaBundleRequirementLocalization =
  | {
      readonly requirementId: string;
      readonly kind: "binding" | "secret";
      readonly replacement: string;
    }
  | {
      readonly requirementId: string;
      readonly kind: "runtime";
      readonly config: Readonly<Record<string, unknown>>;
    };

export interface LocalizePragmaBundleResourcesInput {
  readonly resources: readonly PragmaResource[];
  readonly manifest: PragmaBundleManifest;
  readonly identities?: readonly PragmaBundleIdentityLocalization[] | undefined;
  readonly requirements?: readonly PragmaBundleRequirementLocalization[] | undefined;
  readonly projectArtifactPaths?: Readonly<Record<string, string>> | undefined;
}

export interface LocalizedPragmaBundleResources {
  readonly resources: readonly PragmaResource[];
  readonly resourceMappings: ReadonlyMap<PragmaResourceRef, PragmaResourceRef>;
  readonly unresolvedRequirements: readonly PragmaBundleRequirement[];
}

/**
 * Collects project artifacts declared by resource adapters. Expert/plugin config and other opaque
 * values are intentionally not interpreted as artifact sources.
 */
export function collectPragmaProjectArtifactPaths(
  resources: readonly PragmaResource[],
): readonly string[] {
  const paths = new Set<string>();
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as Record<string, unknown>;
    if (record["type"] === "project" && typeof record["path"] === "string") {
      paths.add(record["path"]);
    }
    Object.values(record).forEach(visit);
  };
  for (const resource of resources) {
    if (isDeclarativeResource(resource)) visit(resource.spec.config);
  }
  return [...paths].toSorted();
}

/** Rebinds only adapter-declared project artifacts in the Host-local resource copy. */
export function remapPragmaProjectArtifactPaths(
  resources: readonly PragmaResource[],
  paths: Readonly<Record<string, string>>,
): readonly PragmaResource[] {
  return resources.map((resource) => {
    if (!isDeclarativeResource(resource)) return PragmaResourceSchema.parse(resource);
    const localized = structuredClone(resource);
    localized.spec.config = rewriteProjectArtifactPaths(localized.spec.config, paths);
    return PragmaResourceSchema.parse(localized);
  });
}

export function remapPragmaResourceIdentities(input: {
  readonly resources: readonly PragmaResource[];
  readonly identities: readonly PragmaBundleIdentityLocalization[];
}): {
  readonly resources: readonly PragmaResource[];
  readonly resourceMappings: ReadonlyMap<PragmaResourceRef, PragmaResourceRef>;
} {
  const byRef = new Map(
    input.resources.map((resource) => [canonicalPragmaResourceRef(resource), resource] as const),
  );
  const identityByRef = new Map(
    input.identities.map((mapping) => [mapping.sourceRef, mapping] as const),
  );
  if (identityByRef.size !== input.identities.length) {
    throw new Error("Bundle identity localization contains duplicate source references.");
  }
  for (const sourceRef of identityByRef.keys()) {
    if (!byRef.has(sourceRef)) {
      throw new Error(
        `Bundle identity localization references an unavailable resource: ${sourceRef}.`,
      );
    }
  }
  const resourceMappings = new Map<PragmaResourceRef, PragmaResourceRef>();
  for (const resource of input.resources) {
    const sourceRef = canonicalPragmaResourceRef(resource);
    const targetId = identityByRef.get(sourceRef)?.targetId ?? resource.metadata.id;
    const separator = sourceRef.indexOf(":");
    resourceMappings.set(
      sourceRef,
      `${sourceRef.slice(0, separator + 1)}${targetId}` as PragmaResourceRef,
    );
  }
  if (new Set(resourceMappings.values()).size !== resourceMappings.size) {
    throw new Error("Bundle identity localization produces duplicate target references.");
  }
  return {
    resources: input.resources.map((resource) =>
      rewriteResourceIdentity(resource, identityByRef, resourceMappings),
    ),
    resourceMappings,
  };
}

/** Returns a validated Host-local copy without mutating the loaded portable Bundle. */
export function localizePragmaBundleResources(
  input: LocalizePragmaBundleResourcesInput,
): LocalizedPragmaBundleResources {
  const remapped = remapPragmaResourceIdentities({
    resources: input.resources,
    identities: input.identities ?? [],
  });
  const resourceMappings = remapped.resourceMappings;
  let resources = [...remapped.resources];
  const localizationByRequirement = new Map(
    (input.requirements ?? []).map(
      (localization) => [localization.requirementId, localization] as const,
    ),
  );
  if (localizationByRequirement.size !== (input.requirements ?? []).length) {
    throw new Error("Bundle requirement localization contains duplicate requirement ids.");
  }
  const requirementById = new Map(
    input.manifest.requirements.map((requirement) => [requirement.id, requirement] as const),
  );
  for (const requirementId of localizationByRequirement.keys()) {
    if (!requirementById.has(requirementId)) {
      throw new Error(`Bundle requirement localization is not declared: ${requirementId}.`);
    }
  }
  const sourceByTarget = new Map(
    [...resourceMappings].map(([sourceRef, targetRef]) => [targetRef, sourceRef] as const),
  );

  resources = resources.map((resource) => {
    const sourceRef = sourceByTarget.get(canonicalPragmaResourceRef(resource));
    if (sourceRef === undefined) return resource;
    const localized = structuredClone(resource);
    for (const requirement of input.manifest.requirements.filter(
      (candidate) => candidate.ownerRef === sourceRef,
    )) {
      const localization = localizationByRequirement.get(requirement.id);
      if (localization === undefined) continue;
      if (localization.kind !== requirement.kind) {
        throw new Error(
          `Bundle requirement localization kind does not match ${requirement.id}: ${localization.kind}.`,
        );
      }
      if (localization.kind === "runtime") {
        if (localized.kind !== "RuntimeProfile") {
          throw new Error(`Bundle Runtime localization owner is invalid: ${requirement.id}.`);
        }
        localized.spec.config = structuredClone(localization.config);
      } else {
        setValueAtPath(localized, requirement.path, localization.replacement);
      }
    }
    if (input.projectArtifactPaths !== undefined && isDeclarativeResource(localized)) {
      localized.spec.config = rewriteProjectArtifactPaths(
        localized.spec.config,
        input.projectArtifactPaths,
      );
    }
    return PragmaResourceSchema.parse(localized);
  });

  return {
    resources,
    resourceMappings,
    unresolvedRequirements: input.manifest.requirements.filter(
      (requirement) => !localizationByRequirement.has(requirement.id),
    ),
  };
}

function rewriteResourceIdentity(
  resource: PragmaResource,
  identities: ReadonlyMap<PragmaResourceRef, PragmaBundleIdentityLocalization>,
  refMap: ReadonlyMap<PragmaResourceRef, PragmaResourceRef>,
): PragmaResource {
  const identity = identities.get(canonicalPragmaResourceRef(resource));
  const rewritten = structuredClone(resource);
  rewritten.metadata.id = identity?.targetId ?? rewritten.metadata.id;
  if (identity?.targetName !== undefined) rewritten.metadata.name = identity.targetName;
  const rewriteRef = <T extends string>(ref: T): T =>
    (refMap.get(ref as PragmaResourceRef) ?? ref) as T;
  const rewriteRuntimeMap = <T extends Record<string, string>>(runtimes: T): T =>
    Object.fromEntries(
      Object.entries(runtimes).map(([expertId, runtimeRef]) => {
        const targetExpert = refMap.get(`expert:${expertId}` as PragmaResourceRef);
        return [targetExpert?.slice("expert:".length) ?? expertId, rewriteRef(runtimeRef)];
      }),
    ) as T;

  if (rewritten.kind === "Expert") {
    if (rewritten.spec.runtime !== undefined) {
      rewritten.spec.runtime.ref = rewriteRef(rewritten.spec.runtime.ref);
    }
    for (const capability of rewritten.spec.capabilities)
      capability.ref = rewriteRef(capability.ref);
    for (const contextStore of rewritten.spec.contextStores) {
      contextStore.ref = rewriteRef(contextStore.ref);
    }
    for (const tool of rewritten.spec.tools) {
      if (tool.target !== undefined) tool.target.ref = rewriteRef(tool.target.ref);
      for (const target of tool.targets ?? []) target.ref = rewriteRef(target.ref);
      if (tool.policy !== undefined) tool.policy.runtimes = rewriteRuntimeMap(tool.policy.runtimes);
    }
  } else if (rewritten.kind === "ExpertTeam") {
    rewritten.spec.coordinator.ref = rewriteRef(rewritten.spec.coordinator.ref);
    for (const member of rewritten.spec.members) member.ref = rewriteRef(member.ref);
    for (const contextStore of rewritten.spec.contextStores) {
      contextStore.ref = rewriteRef(contextStore.ref);
      if (contextStore.visibility.mode !== "all") {
        contextStore.visibility.expertIds = contextStore.visibility.expertIds.map((expertId) => {
          const targetExpert = refMap.get(`expert:${expertId}` as PragmaResourceRef);
          return targetExpert?.slice("expert:".length) ?? expertId;
        });
      }
    }
    if (rewritten.spec.delegation.allow !== undefined) {
      rewritten.spec.delegation.allow = Object.fromEntries(
        Object.entries(rewritten.spec.delegation.allow).map(([expertId, members]) => {
          const targetExpert = refMap.get(`expert:${expertId}` as PragmaResourceRef);
          return [
            targetExpert?.slice("expert:".length) ?? expertId,
            members.map((member) => {
              const targetMember = refMap.get(`expert:${member}` as PragmaResourceRef);
              return targetMember?.slice("expert:".length) ?? member;
            }),
          ];
        }),
      );
    }
    rewritten.spec.delegation.runtimes = rewriteRuntimeMap(rewritten.spec.delegation.runtimes);
  } else if (rewritten.kind === "Flow") {
    for (const step of Object.values(rewritten.spec.graph.steps)) {
      if (step.expert !== undefined) step.expert.ref = rewriteRef(step.expert.ref);
      if (step.team !== undefined) step.team.ref = rewriteRef(step.team.ref);
      if (step.flow !== undefined) step.flow.ref = rewriteRef(step.flow.ref);
      if (step.runtime !== undefined) step.runtime.ref = rewriteRef(step.runtime.ref);
      if (step.runtimes !== undefined) step.runtimes = rewriteRuntimeMap(step.runtimes);
    }
  } else if (rewritten.kind === "Automation") {
    rewritten.spec.route.executor.ref = rewriteRef(rewritten.spec.route.executor.ref);
  } else if (rewritten.kind === "Evaluation") {
    if ("target" in rewritten.spec && rewritten.spec.method.type === "flow-run-dry") {
      rewritten.spec.target.ref = rewriteRef(rewritten.spec.target.ref);
    }
  }
  return PragmaResourceSchema.parse(rewritten);
}

function setValueAtPath(
  value: object,
  path: readonly (string | number)[],
  replacement: unknown,
): void {
  if (path.length === 0) throw new Error("Bundle requirement path cannot be empty.");
  let current: unknown = value;
  for (const segment of path.slice(0, -1)) {
    if (typeof current !== "object" || current === null) {
      throw new Error(`Bundle requirement path is unavailable: ${path.join(".")}.`);
    }
    current = (current as Record<string | number, unknown>)[segment];
  }
  if (typeof current !== "object" || current === null) {
    throw new Error(`Bundle requirement path is unavailable: ${path.join(".")}.`);
  }
  (current as Record<string | number, unknown>)[path.at(-1)!] = replacement;
}

function rewriteProjectArtifactPaths(
  value: unknown,
  paths: Readonly<Record<string, string>>,
): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteProjectArtifactPaths(entry, paths));
  if (typeof value !== "object" || value === null) return value;
  const record = value as Record<string, unknown>;
  if (record["type"] === "project" && typeof record["path"] === "string") {
    const replacement = paths[record["path"]];
    return replacement === undefined ? value : { ...record, path: replacement };
  }
  return Object.fromEntries(
    Object.entries(record).map(([key, entry]) => [key, rewriteProjectArtifactPaths(entry, paths)]),
  );
}

function isDeclarativeResource(
  resource: PragmaResource,
): resource is Extract<PragmaResource, { kind: "Capability" | "ContextStore" | "RuntimeProfile" }> {
  return (
    resource.kind === "Capability" ||
    resource.kind === "ContextStore" ||
    resource.kind === "RuntimeProfile"
  );
}
