import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import { PragmaPaths } from "../src/storage/pragma-paths.ts";

describe("PragmaPaths", () => {
  it("keeps the default workspace directly below the Pragma root", () => {
    const paths = new PragmaPaths({ pragmaHome: join("", "pragma-home") });

    expect(paths.workspaceRoot()).toBe(join(paths.root, "workspace"));
    expect(dirname(paths.workspaceRoot())).toBe(paths.root);
    expect(paths.workspaceRoot()).not.toBe(join(paths.dataRoot(), "workspace"));
  });

  it("owns the complete diagnostic archive path layout", () => {
    const paths = new PragmaPaths({ pragmaHome: join("", "pragma-home") });
    const bootId = "00000000-0000-4000-8000-000000000001";
    const bootRoot = paths.diagnosticBootRoot("desktop", "2026-07-26", bootId);

    expect(bootRoot).toBe(
      join(
        paths.archivesRoot(),
        "diagnostics",
        "desktop",
        "2026-07-26",
        "MDAwMDAwMDAtMDAwMC00MDAwLTgwMDAtMDAwMDAwMDAwMDAx",
      ),
    );
    expect(paths.diagnosticOperationLog("desktop", "2026-07-26", bootId, 1)).toBe(
      join(bootRoot, "operations-0001.jsonl"),
    );
    expect(paths.diagnosticFailureLog("desktop", "2026-07-26", bootId, 12)).toBe(
      join(bootRoot, "errors-0012.jsonl"),
    );
    expect(() => paths.diagnosticBootRoot("desktop", "../escape", bootId)).toThrow(
      "Invalid diagnostic archive date",
    );
  });

  it("places Qoder external commands in the shared rebuildable Runtime cache", () => {
    const paths = new PragmaPaths({ pragmaHome: join("", "pragma-home") });

    expect(paths.qoderCliExternalCommandsCacheRoot()).toBe(
      join(paths.cacheRoot(), "runtimes", "qodercli", "external-commands"),
    );
  });
});
