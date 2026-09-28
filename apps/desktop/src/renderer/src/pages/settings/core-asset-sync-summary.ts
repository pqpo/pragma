import type {
  CoreAssetLogicalKind,
  CoreAssetSyncOverview,
  CoreAssetSyncItemStatus,
} from "../../../../shared/contracts/index.ts";

export type CoreAssetHealth = "synced" | "pending" | "failed";
export type CoreAssetOverallHealth = CoreAssetHealth | "syncing";

export interface CoreAssetSyncLogicalAsset {
  readonly key: string;
  readonly kind: CoreAssetLogicalKind;
  readonly name: string;
  readonly status: CoreAssetHealth;
  readonly records: readonly CoreAssetSyncItemStatus[];
}

export interface CoreAssetSyncGroup {
  readonly kind: CoreAssetLogicalKind;
  readonly total: number;
  readonly synced: number;
  readonly pending: number;
  readonly failed: number;
  readonly assets: readonly CoreAssetSyncLogicalAsset[];
}

export interface CoreAssetSyncSummary {
  readonly total: number;
  readonly synced: number;
  readonly pending: number;
  readonly failed: number;
  readonly groups: readonly CoreAssetSyncGroup[];
}

const KIND_ORDER: readonly CoreAssetLogicalKind[] = [
  "knowledge",
  "context",
  "skill",
  "capability",
  "expert",
  "team",
  "flow",
  "runtime-profile",
];

const HEALTH_PRIORITY: Readonly<Record<CoreAssetHealth, number>> = {
  synced: 0,
  pending: 1,
  failed: 2,
};

export function aggregateCoreAssetSyncItems(
  items: readonly CoreAssetSyncItemStatus[],
): CoreAssetSyncSummary {
  const assets = new Map<string, CoreAssetSyncLogicalAsset>();
  for (const item of items) {
    const itemHealth = syncItemHealth(item.status);
    const current = assets.get(item.assetKey);
    if (current === undefined) {
      assets.set(item.assetKey, {
        key: item.assetKey,
        kind: item.assetKind,
        name: item.assetName,
        status: itemHealth,
        records: [item],
      });
      continue;
    }
    assets.set(item.assetKey, {
      ...current,
      status:
        HEALTH_PRIORITY[itemHealth] > HEALTH_PRIORITY[current.status] ? itemHealth : current.status,
      records: [...current.records, item],
    });
  }

  const groups = KIND_ORDER.flatMap((kind) => {
    const grouped = [...assets.values()]
      .filter((asset) => asset.kind === kind)
      .sort((left, right) => {
        const health = HEALTH_PRIORITY[right.status] - HEALTH_PRIORITY[left.status];
        return health === 0 ? left.name.localeCompare(right.name) : health;
      });
    if (grouped.length === 0) return [];
    return [
      {
        kind,
        total: grouped.length,
        synced: grouped.filter((asset) => asset.status === "synced").length,
        pending: grouped.filter((asset) => asset.status === "pending").length,
        failed: grouped.filter((asset) => asset.status === "failed").length,
        assets: grouped,
      },
    ];
  });

  return {
    total: assets.size,
    synced: [...assets.values()].filter((asset) => asset.status === "synced").length,
    pending: [...assets.values()].filter((asset) => asset.status === "pending").length,
    failed: [...assets.values()].filter((asset) => asset.status === "failed").length,
    groups,
  };
}

export function coreAssetOverallHealth(
  status: CoreAssetSyncOverview["status"],
  summary: Pick<CoreAssetSyncSummary, "failed" | "pending">,
): CoreAssetOverallHealth {
  if (status === "error" || status === "conflict") return "failed";
  if (status === "syncing") return "syncing";
  if (summary.failed > 0) return "failed";
  if (summary.pending > 0) return "pending";
  return "synced";
}

function syncItemHealth(status: CoreAssetSyncItemStatus["status"]): CoreAssetHealth {
  if (status === "conflict" || status === "error") return "failed";
  if (status === "pending" || status === "ignored_remote" || status === "needs_attention")
    return "pending";
  return "synced";
}
