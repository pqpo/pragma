import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CoreAssetSyncStatus, CoreAssetSyncError } from "./CoreAssetSyncSettingsFragment.tsx";

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
