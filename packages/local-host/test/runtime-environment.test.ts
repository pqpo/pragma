import { describe, expect, it } from "vitest";

import { filterLocalHostRuntimeProcessEnvironment } from "../src/index.ts";

describe("Local Host runtime environment", () => {
  it("keeps toolchain variables and excludes credential-like shell state", () => {
    expect(
      filterLocalHostRuntimeProcessEnvironment(
        {
          HOME: "/Users/test",
          PATH: "/usr/bin",
          NVM_DIR: "/Users/test/.nvm",
          XDG_CONFIG_HOME: "/Users/test/config",
          XDG_DATA_HOME: "/Users/test/data",
          OPENCODE_CONFIG_DIR: "/Users/test/opencode-config",
          OPENCODE_CONFIG_CONTENT: '{"token":"canary-secret"}',
          ANTHROPIC_API_KEY: "canary-secret",
          RANDOM_SHELL_STATE: "not-for-runtime",
        },
        "darwin",
      ),
    ).toEqual({
      HOME: "/Users/test",
      PATH: "/usr/bin",
      NVM_DIR: "/Users/test/.nvm",
      XDG_CONFIG_HOME: "/Users/test/config",
      XDG_DATA_HOME: "/Users/test/data",
      OPENCODE_CONFIG_DIR: "/Users/test/opencode-config",
    });
  });

  it("uses the Windows allowlist without treating LC_* as portable", () => {
    expect(
      filterLocalHostRuntimeProcessEnvironment(
        {
          USERPROFILE: "C:\\Users\\test",
          PATH: "C:\\Windows\\System32",
          LC_ALL: "en_US.UTF-8",
          API_TOKEN: "canary-secret",
        },
        "win32",
      ),
    ).toEqual({
      USERPROFILE: "C:\\Users\\test",
      PATH: "C:\\Windows\\System32",
    });
  });
});
