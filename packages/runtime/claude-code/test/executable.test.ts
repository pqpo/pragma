import { posix, win32 } from "node:path";

import { describe, expect, it } from "vitest";

import {
  resolveClaudeCodeCommand,
  resolveClaudeCodeExecutablePath,
} from "../src/executable.ts";

describe("Claude Code executable resolution", () => {
  it("resolves claude.exe from PATH on Windows", () => {
    const binDirectory = win32.join("C:\\", "Program Files", "Claude Code", "bin");
    const executablePath = win32.join(binDirectory, "claude.exe");

    expect(
      resolveClaudeCodeExecutablePath({
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

  it("resolves the native Windows installation from the user profile", () => {
    const homeDirectory = win32.join("C:\\", "Users", "test");
    const executablePath = win32.join(homeDirectory, ".local", "bin", "claude.exe");

    expect(
      resolveClaudeCodeExecutablePath({
        env: { PATH: win32.join("C:\\", "Windows", "System32") },
        homeDirectory,
        platform: "win32",
        isExecutable: (candidate) => candidate.toLowerCase() === executablePath.toLowerCase(),
      }),
    ).toBe(executablePath);
  });

  it("keeps extensionless executable resolution for Unix and managed launchers", () => {
    const binDirectory = posix.join("/", "managed", "bin");
    const executablePath = posix.join(binDirectory, "claude");

    expect(
      resolveClaudeCodeExecutablePath({
        env: { PATH: binDirectory },
        platform: "linux",
        isExecutable: (candidate) => candidate === executablePath,
      }),
    ).toBe(executablePath);
  });

  it("honors an explicitly configured executable path", () => {
    const executablePath = win32.join("D:\\", "tools", "claude.exe");

    expect(resolveClaudeCodeExecutablePath({ executablePath })).toBe(executablePath);
  });

  it("resolves an npm Windows command shim without invoking a shell", () => {
    const shimPath = win32.join("C:\\", "Users", "test", "AppData", "Roaming", "npm", "claude.cmd");
    const nodePath = win32.join("C:\\", "Program Files", "nodejs", "node.exe");

    expect(
      resolveClaudeCodeCommand({
        executablePath: shimPath,
        platform: "win32",
        nodeExecutablePath: nodePath,
        readTextFile: () =>
          '@IF EXIST "%~dp0\\node.exe" (\n  "%~dp0\\node.exe" "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\n)',
      }),
    ).toEqual({
      executablePath: nodePath,
      launcherArgs: [
        win32.join(
          "C:\\",
          "Users",
          "test",
          "AppData",
          "Roaming",
          "npm",
          "node_modules",
          "@anthropic-ai",
          "claude-code",
          "cli.js",
        ),
      ],
      sourcePath: shimPath,
    });
  });

  it("prefers the CMD shim over an extensionless nvm-windows shell shim", () => {
    const binDirectory = win32.join("C:\\", "nvm4w", "nodejs");
    const shellShimPath = win32.join(binDirectory, "claude");
    const commandShimPath = win32.join(binDirectory, "claude.cmd");
    const entrypoint = win32.join(
      binDirectory,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "cli.js",
    );

    expect(
      resolveClaudeCodeCommand({
        env: { PATH: binDirectory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        platform: "win32",
        isExecutable: (candidate) =>
          candidate === shellShimPath || candidate === commandShimPath,
        readTextFile: (path) => {
          expect(path).toBe(commandShimPath);
          return 'node "%~dp0\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*';
        },
        nodeExecutablePath: win32.join(binDirectory, "node.exe"),
      }),
    ).toMatchObject({
      launcherArgs: [entrypoint],
      sourcePath: commandShimPath,
    });
  });

  it("reads Windows Path case-insensitively and unwraps the native nvm-windows shim", () => {
    const binDirectory = win32.join("C:\\", "nvm4w", "nodejs");
    const commandShimPath = win32.join(binDirectory, "claude.cmd");
    const nativeExecutablePath = win32.join(
      binDirectory,
      "node_modules",
      "@anthropic-ai",
      "claude-code",
      "bin",
      "claude.exe",
    );

    expect(
      resolveClaudeCodeCommand({
        env: { Path: binDirectory, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
        platform: "win32",
        isExecutable: (candidate) => candidate === commandShimPath,
        readTextFile: () => [
          "@ECHO off",
          "SET dp0=%~dp0",
          '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*',
        ].join("\n"),
      }),
    ).toEqual({
      executablePath: nativeExecutablePath,
      launcherArgs: [],
      sourcePath: commandShimPath,
    });
  });
});
