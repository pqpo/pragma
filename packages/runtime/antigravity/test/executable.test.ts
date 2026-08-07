import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveAntigravityExecutablePath } from "../src/executable.ts";

describe("resolveAntigravityExecutablePath", () => {
  it("prefers the adapter option and AGY_PATH over discovery", () => {
    expect(
      resolveAntigravityExecutablePath({
        executablePath: "/opt/agy-explicit",
        env: { AGY_PATH: "/opt/agy-env", PATH: "/bin" },
      }),
    ).toBe("/opt/agy-explicit");
    expect(
      resolveAntigravityExecutablePath({
        env: { AGY_PATH: "/opt/agy-env", PATH: "/bin" },
        isExecutable: () => false,
      }),
    ).toBe("/opt/agy-env");
  });

  it("discovers agy and the legacy antigravity binary from PATH", () => {
    expect(
      resolveAntigravityExecutablePath({
        env: { PATH: "/first:/second" },
        platform: "linux",
        isExecutable: (path) => path === "/second/agy",
      }),
    ).toBe("/second/agy");
    expect(
      resolveAntigravityExecutablePath({
        env: { PATH: "/first:/second" },
        platform: "linux",
        isExecutable: (path) => path === "/second/antigravity",
      }),
    ).toBe("/second/antigravity");
  });

  it("uses the documented per-user installation directories", () => {
    expect(
      resolveAntigravityExecutablePath({
        env: { PATH: "", HOME: "/users/alice" },
        platform: "linux",
        isExecutable: (path) => path === "/users/alice/.local/bin/agy",
      }),
    ).toBe("/users/alice/.local/bin/agy");

    const localAppData = win32.join("C:\\", "Users", "Alice", "AppData", "Local");
    const executable = win32.join(localAppData, "agy", "bin", "agy.exe");
    expect(
      resolveAntigravityExecutablePath({
        env: { Path: "", LocalAppData: localAppData, UserProfile: "C:\\Users\\Alice" },
        platform: "win32",
        isExecutable: (path) => path.toLowerCase() === executable.toLowerCase(),
      }),
    ).toBe(executable);
  });

  it("rejects Windows command shims because the Runtime never invokes a shell", () => {
    expect(() =>
      resolveAntigravityExecutablePath({
        executablePath: win32.join("C:\\", "npm", "agy.cmd"),
        platform: "win32",
      }),
    ).toThrow("not directly spawnable");
  });
});
