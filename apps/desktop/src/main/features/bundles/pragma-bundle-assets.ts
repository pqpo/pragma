import { normalizePragmaResourceName, type PragmaResourceRef } from "@pragma/interpreter/ast";

import type { PragmaBundleImportInspection } from "../../../shared/contracts/index.ts";

export interface ImportedBundleAssetCandidate {
  readonly resourceRef: PragmaResourceRef;
  readonly assetKind: "skill" | "knowledge_base";
  readonly name: string;
  readonly fingerprint: string;
  readonly fingerprintKind?: "asset" | "definition";
}

export interface LocalBundleAssetCandidate {
  readonly assetId: string;
  readonly assetKind: "skill" | "knowledge_base";
  readonly name: string;
  readonly revision: number;
  readonly fingerprint: string;
  readonly definitionFingerprint?: string;
  readonly boundResourceRef?: PragmaResourceRef | undefined;
}

export function findBundleAssetConflicts(
  imported: readonly ImportedBundleAssetCandidate[],
  local: readonly LocalBundleAssetCandidate[],
): PragmaBundleImportInspection["assetConflicts"] {
  return imported.flatMap((asset) => {
    const normalizedName = normalizePragmaResourceName(asset.name);
    const candidates = local
      .filter(
        (candidate) =>
          candidate.assetKind === asset.assetKind &&
          normalizePragmaResourceName(candidate.name) === normalizedName,
      )
      .toSorted((left, right) => left.assetId.localeCompare(right.assetId))
      .map((candidate) => ({
        assetId: candidate.assetId,
        name: candidate.name,
        revision: candidate.revision,
        fingerprint:
          asset.fingerprintKind === "definition"
            ? (candidate.definitionFingerprint ?? candidate.fingerprint)
            : candidate.fingerprint,
        ...(candidate.boundResourceRef === undefined
          ? {}
          : { boundResourceRef: candidate.boundResourceRef }),
      }));
    return candidates.length === 0
      ? []
      : [
          {
            resourceRef: asset.resourceRef,
            assetKind: asset.assetKind,
            importedName: asset.name,
            importedFingerprint: asset.fingerprint,
            candidates,
          },
        ];
  });
}

export function nextBundleAssetCopyName(
  sourceName: string,
  occupiedNames: readonly string[],
  maxLength: number,
): string {
  const occupied = new Set(occupiedNames.map(normalizePragmaResourceName));
  let ordinal = 1;
  while (true) {
    const suffix = ordinal === 1 ? " (copy)" : ` (copy ${ordinal})`;
    const candidate = `${sourceName.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`;
    if (!occupied.has(normalizePragmaResourceName(candidate))) return candidate;
    ordinal += 1;
  }
}
