import { describe, expect, it } from "vitest";

import type { CoreAssetSyncItemStatus } from "../../../../shared/contracts/index.ts";
import { aggregateCoreAssetSyncItems, coreAssetOverallHealth } from "./core-asset-sync-summary.ts";

function item(
  input: Partial<CoreAssetSyncItemStatus> &
    Pick<CoreAssetSyncItemStatus, "key" | "kind" | "assetKey" | "assetKind" | "status">,
): CoreAssetSyncItemStatus {
  return {
    name: input.key,
    assetName: input.assetKey,
    ...input,
  };
}

describe("core asset sync summary", () => {
  it("counts multiple synchronization records as one logical asset", () => {
    const summary = aggregateCoreAssetSyncItems([
      item({
        key: "flow:flow:t1e73vjvctx49gkq",
        kind: "flow",
        assetKey: "flow:t1e73vjvctx49gkq",
        assetKind: "flow",
        assetName: "Release",
        status: "synced",
      }),
      item({
        key: "flow-layout:t1e73vjvctx49gkq",
        kind: "flow-layout",
        assetKey: "flow:t1e73vjvctx49gkq",
        assetKind: "flow",
        assetName: "Release",
        status: "pending",
      }),
      item({
        key: "capability:capability:binding-id",
        kind: "capability",
        assetKey: "capability:capability-id",
        assetKind: "capability",
        assetName: "Search",
        status: "synced",
      }),
      item({
        key: "capability:capability-id",
        kind: "capability",
        assetKey: "capability:capability-id",
        assetKind: "capability",
        assetName: "Search",
        status: "synced",
      }),
    ]);

    expect(summary).toMatchObject({ total: 2, synced: 1, pending: 1, failed: 0 });
    expect(summary.groups.find((group) => group.kind === "flow")).toMatchObject({
      total: 1,
      synced: 0,
      pending: 1,
      failed: 0,
    });
    expect(summary.groups.find((group) => group.kind === "capability")).toMatchObject({
      total: 1,
      synced: 1,
      pending: 0,
      failed: 0,
    });
  });

  it("prioritizes failures and treats attention states as pending", () => {
    const summary = aggregateCoreAssetSyncItems([
      item({
        key: "knowledge:one",
        kind: "knowledge",
        assetKey: "knowledge:one",
        assetKind: "knowledge",
        status: "ignored_remote",
      }),
      item({
        key: "expert:expert:one",
        kind: "expert",
        assetKey: "expert:one",
        assetKind: "expert",
        status: "needs_attention",
      }),
      item({
        key: "flow:flow:one",
        kind: "flow",
        assetKey: "flow:one",
        assetKind: "flow",
        status: "pending",
      }),
      item({
        key: "flow-layout:one",
        kind: "flow-layout",
        assetKey: "flow:one",
        assetKind: "flow",
        status: "conflict",
      }),
    ]);

    expect(summary).toMatchObject({ total: 3, synced: 0, pending: 2, failed: 1 });
    expect(summary.groups.find((group) => group.kind === "flow")?.assets[0]).toMatchObject({
      key: "flow:one",
      status: "failed",
    });
  });

  it("reports an operational synchronization error even when every asset is synchronized", () => {
    expect(coreAssetOverallHealth("error", { failed: 0, pending: 0 })).toBe("failed");
    expect(coreAssetOverallHealth("syncing", { failed: 0, pending: 0 })).toBe("syncing");
    expect(coreAssetOverallHealth("ready", { failed: 0, pending: 0 })).toBe("synced");
  });
});
