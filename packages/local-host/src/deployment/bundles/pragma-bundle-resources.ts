import { referencedPragmaResourceRefs } from "../../missions/resource-dependencies.ts";
import { generatePragmaResourceId } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  normalizePragmaResourceName,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import type { PragmaBundleImportInspection } from "../../deployment-contracts/index.ts";

export function findBundleConflicts(
  imported: readonly PragmaResource[],
  local: readonly PragmaResource[],
): PragmaBundleImportInspection["conflicts"] {
  const conflicts: PragmaBundleImportInspection["conflicts"][number][] = [];
  for (const resource of imported) {
    const ref = canonicalPragmaResourceRef(resource);
    const sameIdentity = local.find((candidate) => canonicalPragmaResourceRef(candidate) === ref);
    const sameName = local.find(
      (candidate) =>
        candidate.kind === resource.kind &&
        normalizePragmaResourceName(candidate.metadata.name) ===
          normalizePragmaResourceName(resource.metadata.name) &&
        canonicalPragmaResourceRef(candidate) !== ref,
    );
    const matches = [
      ...(sameIdentity === undefined
        ? []
        : [
            {
              kind: "identity" as const,
              localRef: canonicalPragmaResourceRef(sameIdentity),
              localName: sameIdentity.metadata.name,
            },
          ]),
      ...(sameName === undefined
        ? []
        : [
            {
              kind: "name" as const,
              localRef: canonicalPragmaResourceRef(sameName),
              localName: sameName.metadata.name,
            },
          ]),
    ];
    if (matches.length === 0) continue;
    const updateAllowed = new Set(matches.map((match) => match.localRef)).size === 1;
    conflicts.push({
      ref,
      resourceKind: resource.kind,
      importedName: resource.metadata.name,
      matches,
      updateAllowed,
      ...(updateAllowed
        ? {}
        : {
            updateBlockedReason:
              "The imported identity and name match different local resources. Import this resource as a copy.",
          }),
    });
  }
  return conflicts;
}

export function resolveBundleIdentities(
  resources: readonly PragmaResource[],
  local: readonly PragmaResource[],
  resolutions: readonly {
    readonly resourceRef: string;
    readonly action: "update" | "copy" | "keep_local";
  }[],
): {
  readonly identities: readonly {
    readonly sourceRef: ReturnType<typeof canonicalPragmaResourceRef>;
    readonly targetId: string;
    readonly targetName: string;
  }[];
} {
  const conflicts = findBundleConflicts(resources, local);
  const conflictByRef = new Map(conflicts.map((conflict) => [conflict.ref, conflict]));
  const resolutionByRef = new Map(
    resolutions.map((resolution) => [resolution.resourceRef, resolution.action]),
  );
  if (
    resolutionByRef.size !== resolutions.length ||
    conflicts.some((conflict) => !resolutionByRef.has(conflict.ref)) ||
    resolutions.some((resolution) => !conflictByRef.has(resolution.resourceRef))
  ) {
    throw new Error("Choose one import action for every conflicting resource.");
  }

  const usedIds = new Set([...local, ...resources].map((resource) => resource.metadata.id));
  const idMap = new Map<string, string>();
  for (const resource of resources) {
    const ref = canonicalPragmaResourceRef(resource);
    const conflict = conflictByRef.get(ref);
    if (conflict === undefined) continue;
    const action = resolutionByRef.get(ref);
    if (action === "update" || action === "keep_local") {
      if (!conflict.updateAllowed) {
        throw new Error(conflict.updateBlockedReason ?? `Cannot update ${ref}.`);
      }
      const targetRef = conflict.matches[0]?.localRef;
      if (targetRef === undefined) {
        throw new Error(`Update target ref is missing for ${ref}.`);
      }
      const target = local.find((candidate) => canonicalPragmaResourceRef(candidate) === targetRef);
      if (target === undefined) throw new Error(`Update target is unavailable: ${targetRef}.`);
      idMap.set(resource.metadata.id, target.metadata.id);
      continue;
    }
    let id = generatePragmaResourceId();
    while (usedIds.has(id)) id = generatePragmaResourceId();
    usedIds.add(id);
    idMap.set(resource.metadata.id, id);
  }
  const usedNames = new Set(
    [
      ...local,
      ...resources.filter(
        (resource) => resolutionByRef.get(canonicalPragmaResourceRef(resource)) !== "copy",
      ),
    ].map((resource) => `${resource.kind}\0${normalizePragmaResourceName(resource.metadata.name)}`),
  );
  const identities = resources.flatMap((resource) => {
    let name = resource.metadata.name;
    const action = resolutionByRef.get(canonicalPragmaResourceRef(resource));
    if (action === "copy") {
      let ordinal = 1;
      while (usedNames.has(`${resource.kind}\0${normalizePragmaResourceName(name)}`)) {
        const suffix = ordinal === 1 ? " (copy)" : ` (copy ${ordinal})`;
        name = `${resource.metadata.name.slice(0, Math.max(1, 200 - suffix.length))}${suffix}`;
        ordinal += 1;
      }
    }
    usedNames.add(`${resource.kind}\0${normalizePragmaResourceName(name)}`);
    const targetId = idMap.get(resource.metadata.id);
    return targetId === undefined && name === resource.metadata.name
      ? []
      : [
          {
            sourceRef: canonicalPragmaResourceRef(resource),
            targetId: targetId ?? resource.metadata.id,
            targetName: name,
          },
        ];
  });
  return { identities };
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

/** Computes the graph that will actually exist after resource conflict decisions. */
export function planBundleResources(input: {
  readonly imported: readonly PragmaResource[];
  readonly current: readonly PragmaResource[];
  readonly rootRef: string;
  readonly mappings: ReadonlyMap<
    ReturnType<typeof canonicalPragmaResourceRef>,
    ReturnType<typeof canonicalPragmaResourceRef>
  >;
  readonly conflicts: readonly {
    readonly resourceRef: string;
    readonly action: "copy" | "update" | "keep_local";
  }[];
}) {
  const kept = new Set(
    input.conflicts
      .filter((value) => value.action === "keep_local")
      .map(
        (value) =>
          input.mappings.get(value.resourceRef as ReturnType<typeof canonicalPragmaResourceRef>) ??
          value.resourceRef,
      ),
  );
  const imported = input.imported.filter((value) => !kept.has(canonicalPragmaResourceRef(value)));
  const replacements = new Set(imported.map(canonicalPragmaResourceRef));
  const effective = collectBundleResourceClosure(
    [
      ...input.current.filter((value) => !replacements.has(canonicalPragmaResourceRef(value))),
      ...imported,
    ],
    input.rootRef,
  );
  const refs = new Set(effective.map(canonicalPragmaResourceRef));
  return {
    effective,
    refs,
    resources: imported.filter((value) => refs.has(canonicalPragmaResourceRef(value))),
    sourceRefs: new Set(
      [...input.mappings]
        .filter(([, target]) => refs.has(target) && !kept.has(target))
        .map(([source]) => source),
    ),
  };
}

export function collectBundleResourceClosure(
  resources: readonly PragmaResource[],
  rootRef: string,
): readonly PragmaResource[] {
  const indexed = new Map(resources.map((value) => [canonicalPragmaResourceRef(value), value]));
  const visited = new Set<string>();
  const result: PragmaResource[] = [];
  const pending = [rootRef];
  while (pending.length > 0) {
    const ref = pending.pop()!;
    if (visited.has(ref)) continue;
    visited.add(ref);
    const resource = indexed.get(ref as ReturnType<typeof canonicalPragmaResourceRef>);
    if (resource === undefined) continue;
    result.push(resource);
    pending.push(...referencedPragmaResourceRefs([resource]));
  }
  return result;
}

/** Model settings travel with their actual users; catalog profile names are internal. */
export function bundleRuntimeModels(
  resources: readonly PragmaResource[],
): NonNullable<PragmaBundleImportInspection["runtimeModels"]> {
  const models: NonNullable<PragmaBundleImportInspection["runtimeModels"]> = {};
  const indexed = new Map(
    resources.flatMap(
      (resource) =>
        [
          [resource.metadata.id, resource],
          [canonicalPragmaResourceRef(resource), resource],
        ] as const,
    ),
  );
  for (const resource of resources) {
    if (resource.kind !== "RuntimeProfile") continue;
    const config = resource.spec.config as Record<string, unknown>;
    models[canonicalPragmaResourceRef(resource)] = {
      ...(typeof config["model"] === "string" ? { modelId: config["model"] } : {}),
      consumers: [],
    };
  }
  type Consumer = NonNullable<
    PragmaBundleImportInspection["runtimeModels"]
  >[string]["consumers"][number];
  const add = (ref: string, name: string, usage: Consumer["usage"], target?: string) => {
    const model = models[ref];
    if (model === undefined) return;
    const targetName = target === undefined ? undefined : indexed.get(target)?.metadata.name;
    const consumer = { name, usage, ...(targetName === undefined ? {} : { targetName }) };
    if (
      !model.consumers.some(
        (value) => value.name === name && value.usage === usage && value.targetName === targetName,
      )
    )
      model.consumers.push(consumer);
  };
  for (const resource of resources) {
    const name = resource.metadata.name;
    if (resource.kind === "Expert") {
      if (resource.spec.runtime !== undefined) add(resource.spec.runtime.ref, name, "expert");
      for (const tool of resource.spec.tools)
        for (const [expertId, ref] of Object.entries(tool.policy?.runtimes ?? {}))
          add(ref, name, "tool-delegation", expertId);
    } else if (resource.kind === "ExpertTeam") {
      for (const [expertId, ref] of Object.entries(resource.spec.delegation.runtimes))
        add(ref, name, "team-delegation", expertId);
    } else if (resource.kind === "Flow") {
      for (const step of Object.values(resource.spec.graph.steps)) {
        if (step.runtime !== undefined)
          add(step.runtime.ref, name, "flow", (step.expert ?? step.team ?? step.flow)?.ref);
        for (const [expertId, ref] of Object.entries(step.runtimes ?? {}))
          add(ref, name, "flow", expertId);
      }
    }
  }
  return Object.fromEntries(
    Object.entries(models).filter(([, model]) => model.consumers.length > 0),
  );
}
