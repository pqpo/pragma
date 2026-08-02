import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import { resolveCodexExecutablePath } from "../src/executable.ts";

describe("Codex executable resolution", () => {
  it("resolves codex.exe from PATH on Windows", () => {
    const binDirectory = win32.join("C:\\", "Program Files", "Codex", "bin");
    const executablePath = win32.join(binDirectory, "codex.exe");

    expect(
      resolveCodexExecutablePath({
        env: {
          PATH: [win32.join("C:\\", "other"), binDirectory].join(win32.delimiter),
          PATHEXT: ".COM;.EXE;.BAT;.CMD",
        },
        homeDirectory: win32.join("C:\\", "Users", "test"),
        platform: "win32",
        isExecutable: (candidate) => candidate.toLowerCase() === executablePath.toLowerCase(),
      }),
    ).toBe(executablePath);
  });

  it("resolves the Codex Desktop AppX executable when it is absent from PATH", () => {
    const packageRoot = win32.join(
      "C:\\",
      "Program Files",
      "WindowsApps",
      "OpenAI.Codex_1.0.0.0_x64__test",
    );
    const executablePath = win32.join(packageRoot, "app", "resources", "codex.exe");

    expect(
      resolveCodexExecutablePath({
        env: { PATH: win32.join("C:\\", "Windows", "System32") },
        homeDirectory: win32.join("C:\\", "Users", "test"),
        platform: "win32",
        windowsAppPackageRoots: () => [packageRoot],
        isExecutable: (candidate) => candidate.toLowerCase() === executablePath.toLowerCase(),
      }),
    ).toBe(executablePath);
  });

  it("keeps extensionless executable resolution for Unix and managed launchers", () => {
    const binDirectory = posix.join("/", "managed", "bin");
    const executablePath = posix.join(binDirectory, "codex");

    expect(
      resolveCodexExecutablePath({
        env: { PATH: binDirectory },
        platform: "linux",
        isExecutable: (candidate) => candidate === executablePath,
      }),
    ).toBe(executablePath);
  });

  it("resolves the Codex executable bundled with ChatGPT on macOS", () => {
    const applicationsDirectory = posix.join("/", "Applications");
    const executablePath = posix.join(
      applicationsDirectory,
      "ChatGPT.app",
      "Contents",
      "Resources",
      "codex",
    );

    expect(
      resolveCodexExecutablePath({
        env: { PATH: "/usr/bin:/bin" },
        platform: "darwin",
        macApplicationsDirectories: [applicationsDirectory],
        isExecutable: (candidate) => candidate === executablePath,
      }),
    ).toBe(executablePath);
  });

  it("prefers ChatGPT.app over the legacy Codex.app in each macOS application directory", () => {
    const applicationsDirectory = posix.join("/Users", "test", "Applications");
    const chatGptExecutable = posix.join(
      applicationsDirectory,
      "ChatGPT.app",
      "Contents",
      "Resources",
      "codex",
    );

    expect(
      resolveCodexExecutablePath({
        env: { PATH: "/usr/bin:/bin" },
        platform: "darwin",
        macApplicationsDirectories: [applicationsDirectory],
        isExecutable: (candidate) => candidate.endsWith("/Contents/Resources/codex"),
      }),
    ).toBe(chatGptExecutable);
  });
});
