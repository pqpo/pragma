import {
  formatPragmaYaml,
  migratePragmaDslProjectToCurrent,
  PragmaDslMigrationError,
} from "@pragma/interpreter";
import {
  PragmaForwardCompatibleResourceSchema,
  PRAGMA_DSL_UPGRADE_FROM_API_VERSIONS,
  canonicalPragmaResourceRef,
} from "@pragma/interpreter/ast";
import { z } from "zod";
import type { CoreAssetSyncItem } from "../../../../shared/contracts/index.ts";
import { isResourceItem } from "../../asset-transfer/asset-transfer-service.ts";
import { fingerprint } from "../../asset-transfer/asset-transfer-fingerprint.ts";
import type { SyncState } from "../asset-sync-state.ts";

export function migrateSyncDslItem(item: CoreAssetSyncItem): CoreAssetSyncItem {
  if (!isResourceItem(item)) return item;
  if (fingerprint(item.data) !== item.fingerprint)
    throw new Error(`Sync journal fingerprint does not match resource: ${item.key}`);
  const result = migratePragmaDslProjectToCurrent({
    projectId: "pragma-sync",
    files: new Map([["resource.pragma.yaml", formatPragmaYaml(item.data)]]),
  });
  const data = PragmaForwardCompatibleResourceSchema.parse(result.resources[0]);
  const original = z.object({ kind: z.string() }).parse(item.data);
  if (result.resources.length !== 1 || original.kind !== data.kind)
    throw new Error(`Invalid sync journal resource: ${item.key}`);
  const ref = canonicalPragmaResourceRef(data);
  const namespace = ref.split(":")[0]!;
  const kind = namespace === "context-store" ? "knowledge" : namespace;
  if (item.key !== `${kind}:${ref}`)
    throw new Error(`Sync journal identity does not match resource: ${item.key}`);
  return { ...item, data, fingerprint: fingerprint(data) };
}

// Hash-only checkpoints need proof: a historical candidate must match a stored hash
// and the authoritative forward migration must reproduce the current content.
function legacySyncDslFingerprints(item: CoreAssetSyncItem, hashes: ReadonlySet<string>): string[] {
  if (!isResourceItem(item)) return [];
  const current = PragmaForwardCompatibleResourceSchema.parse(item.data);
  return PRAGMA_DSL_UPGRADE_FROM_API_VERSIONS.flatMap((apiVersion) => {
    const data = { ...current, apiVersion };
    const prior = fingerprint(data);
    if (!hashes.has(prior)) return [];
    try {
      const candidate = migrateSyncDslItem({ ...item, data, fingerprint: prior });
      return candidate.fingerprint === item.fingerprint ? [prior] : [];
    } catch (error) {
      if (error instanceof z.ZodError || error instanceof PragmaDslMigrationError) return [];
      throw error;
    }
  });
}

export function upgradeSyncBaselines(
  state: SyncState,
  candidates: Iterable<CoreAssetSyncItem>,
): SyncState {
  const result = {
    ...state,
    bases: { ...state.bases },
    remoteItems: { ...state.remoteItems },
    unavailableItems: { ...state.unavailableItems },
  };
  for (const item of candidates) {
    const hashes = new Set(
      [
        result.bases[item.key],
        result.remoteItems[item.key]?.fingerprint,
        result.unavailableItems[item.key]?.fingerprint,
      ].filter((hash): hash is string => hash !== undefined && hash !== item.fingerprint),
    );
    if (hashes.size === 0) continue;
    for (const prior of legacySyncDslFingerprints(item, hashes)) {
      if (result.bases[item.key] === prior) result.bases[item.key] = item.fingerprint;
      for (const summaries of [result.remoteItems, result.unavailableItems]) {
        const summary = summaries[item.key];
        if (summary?.fingerprint === prior)
          summaries[item.key] = { ...summary, fingerprint: item.fingerprint };
      }
    }
  }
  return result;
}
