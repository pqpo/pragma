import { describe, expect, it } from "vitest";

import {
  filterLocalHostRuntimeProcessEnvironment,
  resolveLocalHostRuntimeProcessEnvironment,
} from "../src/index.ts";

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

  it("keeps common Java and Android toolchain variables in filtered mode", () => {
    expect(
      filterLocalHostRuntimeProcessEnvironment(
        {
          JAVA_HOME: "/opt/jdk",
          ANDROID_HOME: "/opt/android-sdk",
          ANDROID_SDK_ROOT: "/opt/android-sdk",
          GRADLE_USER_HOME: "/Users/test/.gradle",
          RANDOM_SHELL_STATE: "not-for-runtime",
        },
        "darwin",
      ),
    ).toEqual({
      JAVA_HOME: "/opt/jdk",
      ANDROID_HOME: "/opt/android-sdk",
      ANDROID_SDK_ROOT: "/opt/android-sdk",
      GRADLE_USER_HOME: "/Users/test/.gradle",
    });
  });

  it("supports a per-runtime allowlist and applies the blocklist after it", () => {
    expect(
      resolveLocalHostRuntimeProcessEnvironment(
        {
          PATH: "/usr/bin",
          CUSTOM_TOOL_HOME: "/opt/tool",
          CUSTOM_TOKEN: "secret",
          OTHER_VALUE: "not-allowed",
        },
        "pragma.runtime.codex",
        {
          mode: "filtered",
          allowlist: ["CUSTOM_TOOL_HOME", "CUSTOM_TOKEN", "PATH"],
          blocklist: ["CUSTOM_TOKEN", "PATH"],
        },
        "linux",
      ),
    ).toEqual({ CUSTOM_TOOL_HOME: "/opt/tool" });
  });

  it("passes all variables in inherit-all mode except blocklisted variables", () => {
    expect(
      resolveLocalHostRuntimeProcessEnvironment(
        {
          PATH: "/usr/bin",
          CUSTOM_VALUE: "available",
          API_TOKEN: "secret",
        },
        "pragma.runtime.claude-code",
        { mode: "inherit-all", allowlist: [], blocklist: ["API_TOKEN"] },
        "linux",
      ),
    ).toEqual({ PATH: "/usr/bin", CUSTOM_VALUE: "available" });
  });

  it("passes OpenCode's explicit config content only to the OpenCode adapter", () => {
    const environment = { OPENCODE_CONFIG_CONTENT: '{"provider":"test"}' };

    expect(
      resolveLocalHostRuntimeProcessEnvironment(
        environment,
        "pragma.runtime.opencode",
        undefined,
        "linux",
      ),
    ).toEqual(environment);
    expect(
      resolveLocalHostRuntimeProcessEnvironment(
        environment,
        "pragma.runtime.codex",
        undefined,
        "linux",
      ),
    ).toEqual({});
  });
});
