import { generatePragmaResourceId } from "@pragma/core";
import {
  PragmaResourceSchema,
  canonicalPragmaResourceRef,
  normalizePragmaResourceName,
  type PragmaInvocableResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import type { PragmaBundleImportInspection } from "../../../shared/contracts/index.ts";
import { referencedPragmaResourceRefs } from "../projects/pragma-resource-references.ts";

export function collectResourceClosure(
  root: PragmaInvocableResource,
  allResources: readonly PragmaResource[],
  externalResourceRefs?: ReadonlySet<string>,
): PragmaResource[] {
  const byRef = new Map(
    allResources.map((resource) => [canonicalPragmaResourceRef(resource), resource]),
  );
  const result = new Map<string, PragmaResource>();
  const visit = (resource: PragmaResource): void => {
    const ref = canonicalPragmaResourceRef(resource);
    if (result.has(ref)) return;
    result.set(ref, resource);
    for (const dependencyRef of referencedPragmaResourceRefs([resource])) {
      if (externalResourceRefs?.has(dependencyRef)) continue;
      const dependency = byRef.get(dependencyRef);
      if (dependency === undefined) {
        throw new Error(`Referenced resource is missing: ${dependencyRef}`);
      }
      visit(dependency);
    }
  };
  visit(root);
  return [...result.values()].toSorted((left, right) =>
    canonicalPragmaResourceRef(left).localeCompare(canonicalPragmaResourceRef(right)),
  );
}

export function collectProjectArtifactPaths(resources: readonly PragmaResource[]): string[] {
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
  resources.forEach(visit);
  return [...paths].toSorted();
}

export function makePortableBundleResources(
  resources: readonly PragmaResource[],
): PragmaResource[] {
  return resources.map((resource) => {
    if (resource.kind === "RuntimeProfile") {
      const config =
        typeof resource.spec.config === "object" && resource.spec.config !== null
          ? (resource.spec.config as Record<string, unknown>)
          : {};
      return PragmaResourceSchema.parse({
        ...resource,
        spec: {
          adapter: resource.spec.adapter,
          config: Object.fromEntries(
            ["runtimeId", "providerId", "model", "thinkingLevel"].flatMap((key) =>
              typeof config[key] === "string" ? [[key, config[key]]] : [],
            ),
          ),
        },
      });
    }
    if (
      (resource.kind === "Capability" || resource.kind === "ContextStore") &&
      resource.spec.binding !== undefined
    ) {
      return PragmaResourceSchema.parse({
        ...resource,
        spec: {
          adapter: resource.spec.adapter,
          config: structuredClone(resource.spec.config),
        },
      });
    }
    return PragmaResourceSchema.parse(resource);
  });
}

export function findBundleConflicts(
  imported: readonly PragmaResource[],
  local: readonly PragmaResource[],
): PragmaBundleImportInspection["conflicts"] {
  const conflicts: PragmaBundleImportInspection["conflicts"][number][] = [];
  for (const resource of imported) {
    const ref = canonicalPragmaResourceRef(resource);
    const sameIdentity = local.find((candidate) => canonicalPragmaResourceRef(candidate) === ref);
    if (sameIdentity !== undefined) {
      conflicts.push({
        ref,
        kind: "identity",
        localName: sameIdentity.metadata.name,
        importedName: resource.metadata.name,
      });
    }
    const sameName = local.find(
      (candidate) =>
        candidate.kind === resource.kind &&
        normalizePragmaResourceName(candidate.metadata.name) ===
          normalizePragmaResourceName(resource.metadata.name) &&
        canonicalPragmaResourceRef(candidate) !== ref,
    );
    if (sameName !== undefined) {
      conflicts.push({
        ref,
        kind: "name",
        localName: sameName.metadata.name,
        importedName: resource.metadata.name,
      });
    }
  }
  return conflicts;
}

export function rewriteBundleAsCopy(
  resources: readonly PragmaResource[],
  local: readonly PragmaResource[],
): {
  readonly resources: PragmaResource[];
  readonly refMap: ReadonlyMap<string, string>;
} {
  const usedIds = new Set(local.map((resource) => resource.metadata.id));
  const idMap = new Map<string, string>();
  for (const resource of resources) {
    let id = generatePragmaResourceId();
    while (usedIds.has(id)) id = generatePragmaResourceId();
    usedIds.add(id);
    idMap.set(resource.metadata.id, id);
  }
  const refMap = createRefMap(resources, idMap);
  const usedNames = new Set(
    local.map(
      (resource) => `${resource.kind}\0${normalizePragmaResourceName(resource.metadata.name)}`,
    ),
  );
  const rewrittenResources = resources.map((resource) => {
    const rewritten = rewriteResourceIdentities(resource, idMap, refMap);
    let name = resource.metadata.name;
    let ordinal = 1;
    while (usedNames.has(`${resource.kind}\0${normalizePragmaResourceName(name)}`)) {
      const suffix = ordinal === 1 ? " (copy)" : ` (copy ${ordinal})`;
      name = `${resource.metadata.name.slice(0, Math.max(1, 200 - suffix.length))}${suffix}`;
      ordinal += 1;
    }
    usedNames.add(`${resource.kind}\0${normalizePragmaResourceName(name)}`);
    return PragmaResourceSchema.parse({
      ...rewritten,
      metadata: { ...rewritten.metadata, name },
    });
  });
  return { resources: rewrittenResources, refMap };
}

export function rewriteBundleForUpdate(
  resources: readonly PragmaResource[],
  local: readonly PragmaResource[],
): {
  readonly resources: PragmaResource[];
  readonly refMap: ReadonlyMap<string, string>;
} {
  const idMap = new Map<string, string>();
  const refMap = new Map(
    resources.map((resource) => {
      const sourceRef = canonicalPragmaResourceRef(resource);
      const sameIdentity = local.find(
        (candidate) => canonicalPragmaResourceRef(candidate) === sourceRef,
      );
      const sameName = local.find(
        (candidate) =>
          candidate.kind === resource.kind &&
          normalizePragmaResourceName(candidate.metadata.name) ===
            normalizePragmaResourceName(resource.metadata.name),
      );
      if (
        sameIdentity !== undefined &&
        sameName !== undefined &&
        canonicalPragmaResourceRef(sameName) !== sourceRef
      ) {
        throw new Error(
          `Cannot update ${sourceRef}: its identity and name match different local resources. Import it as a copy instead.`,
        );
      }
      if (sameIdentity !== undefined) return [sourceRef, sourceRef] as const;
      if (sameName === undefined) return [sourceRef, sourceRef] as const;
      idMap.set(resource.metadata.id, sameName.metadata.id);
      return [sourceRef, canonicalPragmaResourceRef(sameName)] as const;
    }),
  );
  return {
    resources: resources.map((resource) => rewriteResourceIdentities(resource, idMap, refMap)),
    refMap,
  };
}

export function rewriteProjectArtifactPaths(
  resource: PragmaResource,
  installationId: string,
  paths: readonly string[],
): PragmaResource {
  const rewrite = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(rewrite);
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    if (
      record["type"] === "project" &&
      typeof record["path"] === "string" &&
      paths.includes(record["path"])
    ) {
      return { ...record, path: `imports/${installationId}/${record["path"]}` };
    }
    return Object.fromEntries(Object.entries(record).map(([key, entry]) => [key, rewrite(entry)]));
  };
  return PragmaResourceSchema.parse(rewrite(resource));
}

export function isBundleOwnedArtifact(path: string): boolean {
  return path.startsWith("imports/");
}

export function artifactPathIsReferenced(
  artifactPath: string,
  referencedPaths: readonly string[],
): boolean {
  return referencedPaths.some(
    (source) =>
      artifactPath === source || artifactPath.startsWith(`${source.replace(/\/+$/, "")}/`),
  );
}

function createRefMap(
  resources: readonly PragmaResource[],
  idMap: ReadonlyMap<string, string>,
): ReadonlyMap<string, string> {
  return new Map(
    resources.map((resource) => [
      canonicalPragmaResourceRef(resource),
      `${resourceKindPrefix(resource)}:${idMap.get(resource.metadata.id)!}`,
    ]),
  );
}

function rewriteResourceIdentities(
  resource: PragmaResource,
  idMap: ReadonlyMap<string, string>,
  refMap: ReadonlyMap<string, string>,
): PragmaResource {
  const rewritten = structuredClone(resource);
  rewritten.metadata.id = idMap.get(resource.metadata.id) ?? resource.metadata.id;
  const rewriteRef = <T extends string>(ref: T): T => (refMap.get(ref) ?? ref) as T;
  const rewriteRuntimeMap = <T extends Record<string, string>>(runtimes: T): T =>
    Object.fromEntries(
      Object.entries(runtimes).map(([expertId, runtimeRef]) => [
        idMap.get(expertId) ?? expertId,
        rewriteRef(runtimeRef),
      ]),
    ) as T;

  if (rewritten.kind === "Expert") {
    if (rewritten.spec.runtime !== undefined) {
      rewritten.spec.runtime.ref = rewriteRef(rewritten.spec.runtime.ref);
    }
    for (const capability of rewritten.spec.capabilities) {
      capability.ref = rewriteRef(capability.ref);
    }
    for (const contextStore of rewritten.spec.contextStores) {
      contextStore.ref = rewriteRef(contextStore.ref);
    }
    for (const tool of rewritten.spec.tools) {
      if (tool.target !== undefined) tool.target.ref = rewriteRef(tool.target.ref);
      for (const target of tool.targets ?? []) target.ref = rewriteRef(target.ref);
      if (tool.policy !== undefined) {
        tool.policy.runtimes = rewriteRuntimeMap(tool.policy.runtimes);
      }
    }
  } else if (rewritten.kind === "ExpertTeam") {
    rewritten.spec.coordinator.ref = rewriteRef(rewritten.spec.coordinator.ref);
    for (const member of rewritten.spec.members) member.ref = rewriteRef(member.ref);
    if (rewritten.spec.delegation.allow !== undefined) {
      rewritten.spec.delegation.allow = Object.fromEntries(
        Object.entries(rewritten.spec.delegation.allow).map(([expertId, members]) => [
          idMap.get(expertId) ?? expertId,
          members.map((member) => idMap.get(member) ?? member),
        ]),
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
  }
  return PragmaResourceSchema.parse(rewritten);
}

function resourceKindPrefix(resource: PragmaResource): string {
  if (resource.kind === "Expert") return "expert";
  if (resource.kind === "ExpertTeam") return "team";
  if (resource.kind === "Flow") return "flow";
  if (resource.kind === "Automation") return "automation";
  if (resource.kind === "Capability") return "capability";
  if (resource.kind === "ContextStore") return "context-store";
  return "runtime-profile";
}
