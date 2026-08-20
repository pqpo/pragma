import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { createDesktopPragmaPaths } from "./desktop-paths.ts";

describe("createDesktopPragmaPaths", () => {
  it("uses the production data root for packaged applications", () => {
    expect(
      createDesktopPragmaPaths({
        isPackaged: true,
        env: {},
        homeDirectory: "/Users/tester",
      }).root,
    ).toBe(join("/Users/tester", ".pragma"));
  });

  it("isolates development builds from production data by default", () => {
    expect(
      createDesktopPragmaPaths({
        isPackaged: false,
        env: {},
        homeDirectory: "/Users/tester",
      }).root,
    ).toBe(join("/Users/tester", ".pragma-development"));
  });

  it("allows an explicit PRAGMA_HOME to opt into another data root", () => {
    expect(
      createDesktopPragmaPaths({
        isPackaged: false,
        env: { PRAGMA_HOME: "/tmp/explicit-pragma" },
        homeDirectory: "/Users/tester",
      }).root,
    ).toBe("/tmp/explicit-pragma");
  });

  it("does not treat a blank PRAGMA_HOME as an explicit production opt-in", () => {
    expect(
      createDesktopPragmaPaths({
        isPackaged: false,
        env: { PRAGMA_HOME: "   " },
        homeDirectory: "/Users/tester",
      }).root,
    ).toBe(join("/Users/tester", ".pragma-development"));
  });
});
