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
});
