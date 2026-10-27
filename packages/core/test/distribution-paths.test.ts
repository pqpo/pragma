import { homedir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DISTRIBUTION } from "@pragma/shared/distribution";
import { PragmaPaths } from "../src/storage/pragma-paths.ts";

afterEach(() => vi.unstubAllGlobals());
describe("distribution business paths", () => {
  it("keeps Pragma defaults and explicit overrides", () => {
    expect(new PragmaPaths({ env: {} }).root).toBe(join(homedir(), ".pragma"));
    expect(new PragmaPaths({ env: { PRAGMA_HOME: "/explicit" } }).root).toBe("/explicit");
  });
  it("ignores the open-source override in a derived build", () => {
    vi.stubGlobal("__PRAGMA_DISTRIBUTION__", {
      ...DEFAULT_DISTRIBUTION,
      homeDirectory: ".acme",
      homeEnvironmentVariable: "ACME_HOME",
    });
    expect(new PragmaPaths({ env: { PRAGMA_HOME: "/wrong" } }).root).toBe(join(homedir(), ".acme"));
    expect(new PragmaPaths({ env: { PRAGMA_HOME: "/wrong", ACME_HOME: "/acme" } }).root).toBe(
      "/acme",
    );
    expect(new PragmaPaths({ pragmaHome: "/worker", env: { ACME_HOME: "/acme" } }).root).toBe(
      "/worker",
    );
  });
});
