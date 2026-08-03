import { generatePragmaResourceId } from "@pragma/core";
import {
  canonicalPragmaResourceRef,
  normalizePragmaResourceName,
  type PragmaResource,
} from "@pragma/interpreter/ast";

import type { PragmaBundleImportInspection } from "../../../shared/contracts/index.ts";

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
    readonly action: "update" | "copy";
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
    if (action === "update") {
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
