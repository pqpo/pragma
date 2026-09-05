import { posix, win32 } from "node:path";

import { describe, expect, it, vi } from "vitest";

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

  it("resolves the Codex App Execution Alias when it is absent from PATH", () => {
    const localAppData = win32.join("C:\\", "Users", "test", "AppData", "Local");
    const executablePath = win32.join(
      localAppData,
      "Microsoft",
      "WindowsApps",
      "codex.exe",
    );

    expect(
      resolveCodexExecutablePath({
        env: {
          LOCALAPPDATA: localAppData,
          PATH: win32.join("C:\\", "Windows", "System32"),
        },
        homeDirectory: win32.join("C:\\", "Users", "test"),
        platform: "win32",
        isExecutable: (candidate) => candidate.toLowerCase() === executablePath.toLowerCase(),
      }),
    ).toBe(executablePath);
  });

  it("resolves the standalone Windows CLI when the desktop process has a narrow PATH", () => {
    const localAppData = win32.join("C:\\", "Users", "test", "AppData", "Local");
    const executablePath = win32.join(
      localAppData,
      "Programs",
      "OpenAI",
      "Codex",
      "bin",
      "codex.exe",
    );

    expect(
      resolveCodexExecutablePath({
        env: {
          LOCALAPPDATA: localAppData,
          PATH: win32.join("C:\\", "Windows", "System32"),
        },
        homeDirectory: win32.join("C:\\", "Users", "test"),
        platform: "win32",
        isExecutable: (candidate) => candidate.toLowerCase() === executablePath.toLowerCase(),
      }),
    ).toBe(executablePath);
  });

  it("does not resolve the protected executable inside a Windows AppX package", () => {
    const packageExecutable = win32.join(
      "C:\\",
      "Program Files",
      "WindowsApps",
      "OpenAI.Codex_1.0.0.0_x64__test",
      "app",
      "resources",
      "codex.exe",
    );

    expect(
      resolveCodexExecutablePath({
        env: { PATH: win32.join("C:\\", "Windows", "System32") },
        homeDirectory: win32.join("C:\\", "Users", "test"),
        platform: "win32",
        isExecutable: (candidate) => candidate.toLowerCase() === packageExecutable.toLowerCase(),
      }),
    ).toBe("codex");
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

  it("finds Codex installed under an NVM-managed Node version outside PATH", () => {
    const homeDirectory = posix.join("/Users", "test");
    const nodeVersionsRoot = posix.join(homeDirectory, ".nvm", "version", "node");
    const executablePath = posix.join(nodeVersionsRoot, "v22.18.0", "bin", "codex");

    expect(
      resolveCodexExecutablePath({
        env: { HOME: homeDirectory, PATH: "/usr/bin:/bin" },
        homeDirectory,
        platform: "darwin",
        macApplicationsDirectories: [],
        readDirectoryNames: (candidate) =>
          candidate === nodeVersionsRoot ? ["v20.19.0", "v22.18.0"] : [],
        isExecutable: (candidate) => candidate === executablePath,
      }),
    ).toBe(executablePath);
  });

  it("prefers the active NVM bin directory before scanning installed versions", () => {
    const activeBin = posix.join("/Users", "test", ".nvm", "versions", "node", "v22.18.0", "bin");
    const executablePath = posix.join(activeBin, "codex");
    const readDirectoryNames = vi.fn<() => readonly string[]>(() => []);

    expect(
      resolveCodexExecutablePath({
        env: { HOME: "/Users/test", PATH: "/usr/bin:/bin", NVM_BIN: activeBin },
        platform: "darwin",
        readDirectoryNames,
        isExecutable: (candidate) => candidate === executablePath,
      }),
    ).toBe(executablePath);
    expect(readDirectoryNames).not.toHaveBeenCalled();
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
