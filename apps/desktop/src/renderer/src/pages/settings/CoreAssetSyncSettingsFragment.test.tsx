import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  CoreAssetSyncStatus,
  CoreAssetSyncError,
  CoreAssetSyncOverviewPanel,
} from "./CoreAssetSyncSettingsFragment.tsx";
import { aggregateCoreAssetSyncItems } from "./core-asset-sync-summary.ts";
import type { CoreAssetSyncItemStatus } from "../../../../shared/contracts/index.ts";

function panel(item: CoreAssetSyncItemStatus) {
  return renderToStaticMarkup(
    <CoreAssetSyncOverviewPanel
      summary={aggregateCoreAssetSyncItems([item])}
      busy={false}
      run={async () => true}
      onOpenStudio={() => {}}
    />,
  );
}
const asset = {
  key: "expert:expert:0123456789abcdef",
  kind: "expert",
  name: "Writer",
  assetKey: "expert:0123456789abcdef",
  assetKind: "expert",
  assetName: "Writer",
} as const;

it("shows ordinary queued changes without resource decision buttons", () => {
  const html = panel({ ...asset, status: "pending" });
  expect(html).toContain("Waiting to sync");
  expect(html).toContain("Queued");
  expect(html).not.toContain("<button");
  expect(html).not.toContain("Deleted locally");
  expect(html).not.toContain("Restore from Git");
});
it("keeps an unavailable model separate from synchronization success", () => {
  const html = panel({
    ...asset,
    status: "synced",
    readiness: { status: "needs_attention", message: "Choose a model" },
  });
  expect(html).toContain("Setup needed to use this asset: Choose a model");
  expect(html).toContain("Open Studio");
  expect(html).not.toContain("Synchronization failed");
  expect(html).not.toContain("Choose a version");
});
it("offers decisions only for real conflicts", () => {
  const html = panel({ ...asset, status: "conflict" });
  expect(html).toContain("Choose a version");
  expect(html).toContain("Keep local");
  expect(html).toContain("Keep Git");
  expect(html).not.toContain("Synchronization failed");
});
it("shows an unreadable authority diagnostic once without conflict choices", () => {
  const message = "asset_sync.local_unavailable: Repair the local asset.";
  const html = panel({
    ...asset,
    status: "error",
    message,
    readiness: { status: "needs_attention", message },
  });
  expect(html.match(/asset_sync.local_unavailable/gu)).toHaveLength(1);
  expect(html).toContain("Open Studio");
  expect(html).not.toContain("Keep local");
});

it("shows an actionable reason and expandable redacted diagnostics", () => {
  const html = renderToStaticMarkup(
    <CoreAssetSyncError
      error={
        "Git push failed: remote: You are not allowed to push code to protected branches. https://user:private@example.test/repo " +
        String.raw`{\"password\":\"example-secret\"}`
      }
    />,
  );
  expect(html).toContain("Check repository policies, branch protection or write permissions");
  expect(html).toContain("<summary>Error details</summary>");
  expect(html).toContain("Git push failed:");
  expect(html).not.toContain("private");
  expect(html).not.toContain("example-secret");
});

it("retains structured error codes when rendering an IPC failure", () => {
  const html = renderToStaticMarkup(
    <CoreAssetSyncError
      error={{
        code: "asset_git_metadata_invalid",
        message: "YAML parse failed.",
      }}
    />,
  );
  expect(html).toContain("The document metadata YAML is invalid");
  expect(html).toContain("YAML parse failed.");
});

describe("CoreAssetSyncStatus", () => {
  const props = {
    message: "All core assets are synchronized.",
    status: "synced" as const,
    loading: false,
    busy: false,
    configured: true,
    onSync: () => undefined,
  };
  it("shows manual synchronization and last sync time without configuration fields", () => {
    const html = renderToStaticMarkup(
      <CoreAssetSyncStatus {...props} syncedAt="2026-10-10T13:47:00Z" />,
    );
    expect(html).toContain("Sync now");
    expect(html).toContain("Last synchronized:");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Save and sync");
    expect(html).not.toContain("Remove configuration");
  });
  it("disables manual sync and uses a disc indicator while syncing", () => {
    const html = renderToStaticMarkup(
      <CoreAssetSyncStatus {...props} status="syncing" busy message="Synchronizing core assets…" />,
    );
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('class="core-asset-sync-disc"');
    expect(html).toContain("disabled");
  });
  it("does not allow manual synchronization before a repository is configured", () => {
    const html = renderToStaticMarkup(<CoreAssetSyncStatus {...props} configured={false} />);
    expect(html).toContain("Not synchronized yet");
    expect(html).toContain("disabled");
  });
});
