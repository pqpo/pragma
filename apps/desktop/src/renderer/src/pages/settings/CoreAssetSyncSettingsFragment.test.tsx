import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CoreAssetSyncActions, CoreAssetSyncError } from "./CoreAssetSyncSettingsFragment.tsx";

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

describe("CoreAssetSyncActions", () => {
  it("uses the shared action styles for every configured sync action", () => {
    const html = renderToStaticMarkup(
      <CoreAssetSyncActions
        busy={false}
        configured
        onSync={() => undefined}
        onRemove={() => undefined}
      />,
    );

    expect(html).toContain('class="primary-button"');
    expect(html).toContain("Save and sync");
    expect(html).toContain('class="secondary-button"');
    expect(html).toContain("Sync now");
    expect(html).toContain('class="danger-button"');
    expect(html).toContain("Remove configuration");
  });

  it("only shows save before sync has been configured", () => {
    const html = renderToStaticMarkup(
      <CoreAssetSyncActions
        busy={false}
        configured={false}
        onSync={() => undefined}
        onRemove={() => undefined}
      />,
    );

    expect(html).toContain("Save and sync");
    expect(html).not.toContain("Sync now");
    expect(html).not.toContain("Remove configuration");
  });
});
