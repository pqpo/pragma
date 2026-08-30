import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MACOS_BUNDLE_ID = "com.pqpo.pragma";
const MACOS_PLIST_PATHS = (homeDirectory: string): readonly string[] => [
  "/Applications/Pragma.app/Contents/Info.plist",
  join(homeDirectory, "Applications/Pragma.app/Contents/Info.plist"),
];

// electron-builder 26.15.3 derives this UUID v5 from appId=com.pqpo.pragma.
// Keep it aligned with apps/desktop/electron-builder.yml and its NSIS uninstall entry.
const WINDOWS_UNINSTALL_GUID = "a5a058dd-b5ec-5fb0-bd32-59ea8f559e83";
const WINDOWS_UNINSTALL_KEY_BASE = "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall";
const WINDOWS_UNINSTALL_KEYS = [
  `HKCU\\${WINDOWS_UNINSTALL_KEY_BASE}\\${WINDOWS_UNINSTALL_GUID}`,
  `HKLM\\${WINDOWS_UNINSTALL_KEY_BASE}\\${WINDOWS_UNINSTALL_GUID}`,
] as const;
const DEFAULT_COMMAND_TIMEOUT_MS = 2_000;
const MAX_COMMAND_OUTPUT_BYTES = 64 * 1024;

export interface DesktopVersionCommandOptions {
  readonly timeoutMs: number;
}

export interface DesktopVersionCommandResult {
  readonly stdout: string;
}

export type DesktopVersionCommandRunner = (
  command: string,
  args: readonly string[],
  options: DesktopVersionCommandOptions,
) => Promise<DesktopVersionCommandResult>;

export interface DesktopVersionDetectorOptions {
  readonly platform?: NodeJS.Platform;
  readonly homeDirectory?: string;
  readonly commandRunner?: DesktopVersionCommandRunner;
  readonly timeoutMs?: number;
}

export async function detectInstalledDesktopVersion(
  options: DesktopVersionDetectorOptions = {},
): Promise<string | undefined> {
  const platform = options.platform ?? process.platform;
  const commandRunner = options.commandRunner ?? runCommand;
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  if (platform === "darwin") {
    return await detectMacosDesktopVersion(
      options.homeDirectory ?? homedir(),
      commandRunner,
      timeoutMs,
    );
  }
  if (platform === "win32") {
    return await detectWindowsDesktopVersion(commandRunner, timeoutMs);
  }
  return undefined;
}

async function detectMacosDesktopVersion(
  homeDirectory: string,
  commandRunner: DesktopVersionCommandRunner,
  timeoutMs: number,
): Promise<string | undefined> {
  const seenPaths = new Set<string>();
  for (const plistPath of MACOS_PLIST_PATHS(homeDirectory)) {
    if (seenPaths.has(plistPath)) continue;
    seenPaths.add(plistPath);
    try {
      const bundleId = await readPlistValue(
        plistPath,
        "CFBundleIdentifier",
        commandRunner,
        timeoutMs,
      );
      if (bundleId !== MACOS_BUNDLE_ID) continue;
      const version = await readPlistValue(
        plistPath,
        "CFBundleShortVersionString",
        commandRunner,
        timeoutMs,
      );
      if (version !== undefined) return version;
    } catch {
      // A missing, malformed, or unreadable candidate must not make `version` fail.
    }
  }
  return undefined;
}

async function readPlistValue(
  plistPath: string,
  key: "CFBundleIdentifier" | "CFBundleShortVersionString",
  commandRunner: DesktopVersionCommandRunner,
  timeoutMs: number,
): Promise<string | undefined> {
  const result = await commandRunner(
    "/usr/bin/plutil",
    ["-extract", key, "raw", "-o", "-", plistPath],
    { timeoutMs },
  );
  return nonEmptyTrimmed(result.stdout);
}

async function detectWindowsDesktopVersion(
  commandRunner: DesktopVersionCommandRunner,
  timeoutMs: number,
): Promise<string | undefined> {
  for (const uninstallKey of WINDOWS_UNINSTALL_KEYS) {
    try {
      const result = await commandRunner(
        "reg.exe",
        ["query", uninstallKey, "/v", "DisplayVersion", "/reg:64"],
        { timeoutMs },
      );
      const version = parseWindowsDisplayVersion(result.stdout);
      if (version !== undefined) return version;
    } catch {
      // HKCU may be absent and reg.exe may fail for an inaccessible HKLM key.
    }
  }
  return undefined;
}

function parseWindowsDisplayVersion(output: string): string | undefined {
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*DisplayVersion\s+REG_SZ\s+(.+?)\s*$/iu.exec(line);
    const version = match?.[1];
    if (version !== undefined) return nonEmptyTrimmed(version);
  }
  return undefined;
}

function nonEmptyTrimmed(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

async function runCommand(
  command: string,
  args: readonly string[],
  options: DesktopVersionCommandOptions,
): Promise<DesktopVersionCommandResult> {
  const result = await execFileAsync(command, [...args], {
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_OUTPUT_BYTES,
    timeout: options.timeoutMs,
    windowsHide: true,
  });
  return { stdout: result.stdout };
}
