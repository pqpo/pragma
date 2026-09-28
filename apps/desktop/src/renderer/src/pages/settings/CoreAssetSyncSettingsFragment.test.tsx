import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { CoreAssetSyncActions } from "./CoreAssetSyncSettingsFragment.tsx";

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
