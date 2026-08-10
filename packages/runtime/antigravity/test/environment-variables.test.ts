import { describe, expect, it } from "vitest";

import {
  applyCommonAntigravityEnvironment,
  deleteEnvironmentValue,
} from "../src/environment-variables.ts";

describe("Antigravity environment variables", () => {
  it("uses case-sensitive deletion on POSIX", () => {
    const env = { TARGET: "remove", target: "preserve" };

    deleteEnvironmentValue(env, "TARGET", "linux");

    expect(env).toEqual({ target: "preserve" });
  });

  it("deletes every case variant on Windows", () => {
    const env = { TARGET: "remove", Target: "also-remove", KEEP: "preserve" };

    deleteEnvironmentValue(env, "target", "win32");

    expect(env).toEqual({ KEEP: "preserve" });
  });

  it("replaces Windows case variants with canonical common overrides", () => {
    const env = {
      Tmp: "C:\\Host\\tmp",
      no_color: "0",
      AGY_CLI_DISABLE_AUTO_UPDATE: "false",
    };

    applyCommonAntigravityEnvironment({
      env,
      tmpDir: "C:\\Pragma\\tmp",
      platform: "win32",
    });

    expect(env).toMatchObject({
      XDG_RUNTIME_DIR: "C:\\Pragma\\tmp",
      TMPDIR: "C:\\Pragma\\tmp",
      TMP: "C:\\Pragma\\tmp",
      TEMP: "C:\\Pragma\\tmp",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
      NO_COLOR: "1",
    });
    expect(Object.keys(env).some((key) => key === "Tmp" || key === "no_color")).toBe(false);
  });
});
