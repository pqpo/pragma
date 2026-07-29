import { win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveQoderCliExecutablePath } from "../src/executable.ts";

describe("resolveQoderCliExecutablePath", () => {
  it("prefers an explicit adapter path", () => {
    expect(
      resolveQoderCliExecutablePath({
        executablePath: "/opt/qoder/qodercli",
        env: { QODERCLI_PATH: "/ignored/qodercli" },
      }),
    ).toBe("/opt/qoder/qodercli");
  });

  it("uses QODERCLI_PATH before PATH discovery", () => {
    expect(
      resolveQoderCliExecutablePath({
        env: { QODERCLI_PATH: "/managed/qodercli", PATH: "/bin" },
        isExecutable: () => false,
      }),
    ).toBe("/managed/qodercli");
  });

  it("discovers the executable from PATH", () => {
    expect(
      resolveQoderCliExecutablePath({
        env: { PATH: "/first:/second" },
        platform: "linux",
        isExecutable: (path) => path === "/second/qodercli",
      }),
    ).toBe("/second/qodercli");
  });

  it("resolves qodercli.exe from a case-insensitive Windows Path", () => {
    const directory = win32.join("C:\\", "Qoder", "bin");
    const executable = win32.join(directory, "qodercli.exe");
    expect(
      resolveQoderCliExecutablePath({
        env: { Path: directory },
        platform: "win32",
        isExecutable: (path) => path.toLowerCase() === executable.toLowerCase(),
      }),
    ).toBe(executable);
  });

  it("rejects a Windows command shim instead of spawning it through a shell", () => {
    expect(() =>
      resolveQoderCliExecutablePath({
        executablePath: win32.join("C:\\", "npm", "qodercli.cmd"),
        platform: "win32",
      }),
    ).toThrow("not directly spawnable");
  });
});
