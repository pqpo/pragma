import { getDistribution } from "@pragma/shared/distribution";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const MACOS_PLIST_PATHS = (homeDirectory: string): readonly string[] => [
  `/Applications/${getDistribution().executableName}.app/Contents/Info.plist`,
  join(homeDirectory, `Applications/${getDistribution().executableName}.app/Contents/Info.plist`),
];

// electron-builder default NSIS GUID, derived from this distribution's app ID.
function windowsUninstallKeys(): readonly string[] {
  const bytes = createHash("sha1")
    .update(Buffer.from("50e065bc313411e69bab38c9862bdaf3", "hex"))
    .update(getDistribution().applicationId)
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 15) | 80;
  bytes[8] = (bytes[8]! & 63) | 128;
  const hex = bytes.toString("hex");
  const guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  return ["HKCU", "HKLM"].map(
    (hive) => `${hive}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${guid}`,
  );
}
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
  // A bundled CLI reports its own Desktop even when another app exists in /Applications.
  if (
    Object.keys(options).length === 0 &&
    process.argv[1]?.replaceAll("\\", "/").includes("/desktop-cli/")
  ) {
    try {
      const metadata: unknown = JSON.parse(
        await readFile(join(dirname(process.argv[1]), "distribution.json"), "utf8"),
      );
      if (
        typeof metadata === "object" &&
        metadata !== null &&
        "desktopVersion" in metadata &&
        typeof metadata.desktopVersion === "string"
      )
        return metadata.desktopVersion;
    } catch {
      /* Fall back to installed app discovery for incomplete distributions. */
    }
  }
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
      if (bundleId !== getDistribution().applicationId) continue;
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
  for (const uninstallKey of windowsUninstallKeys()) {
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
