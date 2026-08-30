import { afterEach, describe, expect, it, vi } from "vitest";

import {
  detectInstalledDesktopVersion,
  type DesktopVersionCommandRunner,
} from "../src/desktop-version.ts";
import { versionResult } from "../src/commands/readonly.ts";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("detectInstalledDesktopVersion", () => {
  it("reads the validated macOS bundle version from /Applications", async () => {
    const calls: string[][] = [];
    const commandRunner: DesktopVersionCommandRunner = async (command, args, options) => {
      expect(command).toBe("/usr/bin/plutil");
      expect(options.timeoutMs).toBe(321);
      calls.push([...args]);
      return {
        stdout:
          args[1] === "CFBundleIdentifier"
            ? "com.pqpo.pragma\n"
            : args[1] === "CFBundleShortVersionString"
              ? "0.2.23\n"
              : "",
      };
    };

    await expect(
      detectInstalledDesktopVersion({
        platform: "darwin",
        homeDirectory: "/Users/tester",
        commandRunner,
        timeoutMs: 321,
      }),
    ).resolves.toBe("0.2.23");
    expect(calls).toEqual([
      [
        "-extract",
        "CFBundleIdentifier",
        "raw",
        "-o",
        "-",
        "/Applications/Pragma.app/Contents/Info.plist",
      ],
      [
        "-extract",
        "CFBundleShortVersionString",
        "raw",
        "-o",
        "-",
        "/Applications/Pragma.app/Contents/Info.plist",
      ],
    ]);
  });

  it("falls back to ~/Applications when the system bundle is unavailable", async () => {
    const calls: string[] = [];
    const commandRunner: DesktopVersionCommandRunner = async (_command, args) => {
      const plistPath = args.at(-1);
      if (plistPath === "/Applications/Pragma.app/Contents/Info.plist") {
        throw new Error("bundle not found");
      }
      calls.push(`${args[1]}:${plistPath}`);
      return { stdout: args[1] === "CFBundleIdentifier" ? "com.pqpo.pragma" : "0.2.23" };
    };

    await expect(
      detectInstalledDesktopVersion({
        platform: "darwin",
        homeDirectory: "/Users/tester",
        commandRunner,
      }),
    ).resolves.toBe("0.2.23");
    expect(calls).toEqual([
      "CFBundleIdentifier:/Users/tester/Applications/Pragma.app/Contents/Info.plist",
      "CFBundleShortVersionString:/Users/tester/Applications/Pragma.app/Contents/Info.plist",
    ]);
  });

  it("rejects a macOS bundle with a different bundle id", async () => {
    const commandRunner: DesktopVersionCommandRunner = async (_command, args) => ({
      stdout: args[1] === "CFBundleIdentifier" ? "com.example.other" : "9.9.9",
    });

    await expect(
      detectInstalledDesktopVersion({
        platform: "darwin",
        homeDirectory: "/Users/tester",
        commandRunner,
      }),
    ).resolves.toBeUndefined();
  });

  it("returns unknown-compatible undefined for an empty or damaged macOS version", async () => {
    const damagedRunner: DesktopVersionCommandRunner = async () => {
      throw new Error("malformed plist");
    };
    await expect(
      detectInstalledDesktopVersion({
        platform: "darwin",
        homeDirectory: "/Users/tester",
        commandRunner: damagedRunner,
      }),
    ).resolves.toBeUndefined();

    const emptyVersionRunner: DesktopVersionCommandRunner = async (_command, args) => ({
      stdout: args[1] === "CFBundleIdentifier" ? "com.pqpo.pragma" : "  \n",
    });
    await expect(
      detectInstalledDesktopVersion({
        platform: "darwin",
        homeDirectory: "/Users/tester",
        commandRunner: emptyVersionRunner,
      }),
    ).resolves.toBeUndefined();
  });

  it("reads DisplayVersion from the per-user Windows uninstall key", async () => {
    const calls: { command: string; args: readonly string[]; timeoutMs: number }[] = [];
    const commandRunner: DesktopVersionCommandRunner = async (command, args, options) => {
      calls.push({ command, args, timeoutMs: options.timeoutMs });
      return {
        stdout:
          "HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a5a058dd-b5ec-5fb0-bd32-59ea8f559e83\r\n" +
          "    DisplayVersion    REG_SZ    0.2.23\r\n",
      };
    };

    await expect(
      detectInstalledDesktopVersion({
        platform: "win32",
        commandRunner,
        timeoutMs: 654,
      }),
    ).resolves.toBe("0.2.23");
    expect(calls).toEqual([
      {
        command: "reg.exe",
        args: [
          "query",
          "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a5a058dd-b5ec-5fb0-bd32-59ea8f559e83",
          "/v",
          "DisplayVersion",
          "/reg:64",
        ],
        timeoutMs: 654,
      },
    ]);
  });

  it("falls back from HKCU to HKLM on Windows", async () => {
    const roots: string[] = [];
    const commandRunner: DesktopVersionCommandRunner = async (_command, args) => {
      roots.push(args[1] ?? "");
      if (args[1]?.startsWith("HKCU\\") === true) throw new Error("key not found");
      return { stdout: "    DisplayVersion    REG_SZ    0.2.23\n" };
    };

    await expect(detectInstalledDesktopVersion({ platform: "win32", commandRunner })).resolves.toBe(
      "0.2.23",
    );
    expect(roots).toEqual([
      "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a5a058dd-b5ec-5fb0-bd32-59ea8f559e83",
      "HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\a5a058dd-b5ec-5fb0-bd32-59ea8f559e83",
    ]);
  });

  it("returns undefined for missing, malformed, or timed-out Windows registry probes", async () => {
    const commandRunner: DesktopVersionCommandRunner = async () => {
      throw new Error("reg.exe timed out");
    };

    await expect(
      detectInstalledDesktopVersion({ platform: "win32", commandRunner }),
    ).resolves.toBeUndefined();

    const malformedRunner: DesktopVersionCommandRunner = async () => ({
      stdout: "    DisplayVersion    REG_DWORD    0.2.23\n",
    });
    await expect(
      detectInstalledDesktopVersion({ platform: "win32", commandRunner: malformedRunner }),
    ).resolves.toBeUndefined();
  });

  it("does not probe unsupported platforms", async () => {
    const commandRunner = vi.fn<DesktopVersionCommandRunner>();

    await expect(
      detectInstalledDesktopVersion({ platform: "linux", commandRunner }),
    ).resolves.toBeUndefined();
    expect(commandRunner).not.toHaveBeenCalled();
  });
});

describe("versionResult", () => {
  it("uses the detector result and keeps the legacy environment variable out of the product path", async () => {
    vi.stubEnv("PRAGMA_DESKTOP_BUNDLE_VERSION", "9.9.9");

    await expect(versionResult("0.0.0", async () => "0.2.23")).resolves.toMatchObject({
      cliVersion: "0.0.0",
      desktopBundleVersion: "0.2.23",
    });
  });

  it("maps a failed or missing detector result to unknown", async () => {
    await expect(versionResult("0.0.0", async () => undefined)).resolves.toMatchObject({
      desktopBundleVersion: "unknown",
    });
  });
});
