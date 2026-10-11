import { execFile } from "node:child_process";
import { access, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import type { DesktopTerminalIntegration } from "../../../shared/contracts/terminal-integration.ts";
import {
  atomicWrite,
  BEGIN,
  LAUNCHER_MARKER,
  shellPathBlock,
  shellQuote,
  updateShellConfig,
} from "./shell-registration.ts";

const execute = promisify(execFile);
export interface TerminalIntegrationOptions {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly executable: string;
  readonly resources: string;
  readonly desktopVersion: string;
  readonly home?: string;
  readonly environment?: NodeJS.ProcessEnv;
}

export function createTerminalIntegration(options: TerminalIntegrationOptions) {
  const home = options.home ?? homedir();
  const environment = options.environment ?? process.env;
  const powershell = join(
    environment["SystemRoot"] ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const installed =
    options.isPackaged &&
    (options.platform === "win32" ||
      (options.platform === "darwin" &&
        !options.executable.startsWith("/Volumes/") &&
        !options.executable.includes("/AppTranslocation/")));
  const directory =
    options.platform === "win32"
      ? join(dirname(options.executable), "bin")
      : join(home, ".pragma", "bin");
  const client = join(
    options.resources,
    "app.asar.unpacked",
    "out",
    "main",
    "desktop-cli",
    "pragma.js",
  );
  const disabled = join(home, ".pragma", "state", "desktop-cli", "disabled");
  let lastError: string | undefined;
  let pending: Promise<unknown> = Promise.resolve();
  const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = pending.then(operation, operation);
    pending = result.catch(() => undefined);
    return result;
  };
  const exists = async (path: string) =>
    await access(path).then(
      () => true,
      () => false,
    );
  const shellFiles = async (): Promise<readonly [string, "zsh" | "bash" | "fish"][]> => {
    let zdotdir = environment["ZDOTDIR"];
    if (zdotdir === undefined && options.platform === "darwin") {
      try {
        const result = await execute(
          "/bin/zsh",
          ["-lc", 'printf "\\nPRAGMA_ZDOTDIR=%s\\n" "${ZDOTDIR:-$HOME}"'],
          { timeout: 3_000, maxBuffer: 64 * 1024 },
        );
        zdotdir = result.stdout
          .split("\n")
          .find((line) => line.startsWith("PRAGMA_ZDOTDIR="))
          ?.slice(15);
      } catch {
        /* Default zsh location if login configuration cannot run. */
      }
    }
    const bashLogin = (await exists(join(home, ".bash_profile")))
      ? ".bash_profile"
      : (await exists(join(home, ".bash_login")))
        ? ".bash_login"
        : (await exists(join(home, ".profile")))
          ? ".profile"
          : ".bash_profile";
    return [
      [join(resolve(home, zdotdir || home), ".zshrc"), "zsh"],
      [join(home, ".bashrc"), "bash"],
      [join(home, bashLogin), "bash"],
      [
        join(
          environment["XDG_CONFIG_HOME"] || join(home, ".config"),
          "fish",
          "conf.d",
          "pragma-desktop.fish",
        ),
        "fish",
      ],
    ];
  };
  const windowsAction = async (action: "repair" | "remove") => {
    const script = join(options.resources, "terminal-integration.ps1");
    const quote = (s: string) => `'${s.replaceAll("'", "''")}'`;
    const inner = `try { & ${quote(script)} -Action ${quote(action)} -InstallDirectory ${quote(dirname(options.executable))}; exit 0 } catch { Write-Error $_; exit 1 }`;
    const encoded = Buffer.from(inner, "utf16le").toString("base64");
    const command = `$p = Start-Process -FilePath "$PSHOME\\powershell.exe" -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-EncodedCommand','${encoded}'; exit $p.ExitCode`;
    try {
      await execute(
        powershell,
        ["-NoProfile", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")],
        { timeout: 120_000, windowsHide: true },
      );
    } catch {
      throw new Error(
        "CLI_REGISTRATION_FAILED: Administrator approval was declined or the operation failed. Retry with administrator approval, or reinstall Desktop.",
      );
    }
  };
  async function inspect(): Promise<DesktopTerminalIntegration> {
    let cliVersion: string | undefined;
    try {
      const metadata: unknown = JSON.parse(
        await readFile(join(dirname(client), "distribution.json"), "utf8"),
      );
      if (
        typeof metadata === "object" &&
        metadata !== null &&
        "cliVersion" in metadata &&
        typeof metadata.cliVersion === "string"
      )
        cliVersion = metadata.cliVersion;
    } catch {
      /* Diagnosed below. */
    }
    let ready = installed && cliVersion !== undefined && (await exists(client));
    if (ready && options.platform === "darwin") {
      for (const name of ["pragma", "pragma-desktop"]) {
        try {
          ready &&=
            (await readFile(join(directory, name), "utf8")).includes(shellQuote(client)) &&
            ((await stat(join(directory, name))).mode & 0o111) !== 0;
        } catch {
          ready = false;
        }
      }
      for (const [path, shell] of await shellFiles()) {
        try {
          ready &&= (await readFile(path, "utf8")).includes(shellPathBlock(directory, shell));
        } catch {
          ready = false;
        }
      }
    } else if (ready && options.platform === "win32") {
      for (const name of ["pragma.cmd", "pragma-desktop.cmd"])
        ready &&= await exists(join(directory, name));
      try {
        const result = await execute(
          powershell,
          ["-NoProfile", "-Command", '[Environment]::GetEnvironmentVariable("Path", "Machine")'],
          { timeout: 5_000, windowsHide: true },
        );
        ready &&= result.stdout.trim().split(";")[0]?.toLowerCase() === directory.toLowerCase();
      } catch {
        ready = false;
      }
    }
    const removed = await exists(disabled);
    let removalIncomplete = false;
    if (removed && options.platform === "darwin") {
      for (const name of ["pragma", "pragma-desktop"]) {
        try {
          removalIncomplete ||= (await readFile(join(directory, name), "utf8")).includes(
            LAUNCHER_MARKER,
          );
        } catch {
          /* Already removed. */
        }
      }
      for (const [path] of await shellFiles()) {
        try {
          removalIncomplete ||= (await readFile(path, "utf8")).includes(BEGIN);
        } catch {
          /* Already removed. */
        }
      }
    }
    if (removed && options.platform === "win32") {
      for (const name of ["pragma.cmd", "pragma-desktop.cmd"]) {
        try {
          removalIncomplete ||= (await readFile(join(directory, name), "utf8")).includes(
            "rem Pragma Desktop CLI launcher",
          );
        } catch {
          /* Already removed. */
        }
      }
    }
    if (removalIncomplete)
      lastError = "CLI_REMOVAL_INCOMPLETE: Retry removing terminal integration.";
    return {
      status: !installed
        ? "unavailable"
        : lastError !== undefined
          ? "failed"
          : removed
            ? "removed"
            : ready
              ? "ready"
              : "failed",
      commandDirectory: directory,
      desktopVersion: options.desktopVersion,
      ...(cliVersion === undefined ? {} : { cliVersion }),
      ...(lastError === undefined && (!installed || removed || ready)
        ? {}
        : {
            error:
              lastError ??
              "CLI_REGISTRATION_MISSING: Repair terminal integration, or reinstall Desktop if its bundled CLI is missing.",
          }),
    };
  }
  async function repair() {
    if (!installed) return await inspect();
    try {
      await access(client);
      if (options.platform === "win32") await windowsAction("repair");
      else {
        const source = `#!/bin/sh\n${LAUNCHER_MARKER}\nif [ ! -x ${shellQuote(options.executable)} ] || [ ! -f ${shellQuote(client)} ]; then\n  printf '%s\\n' 'Pragma Desktop has been removed or moved. Open the installed Desktop to repair terminal integration.' >&2\n  exit 127\nfi\nELECTRON_RUN_AS_NODE=1 exec ${shellQuote(options.executable)} ${shellQuote(client)} "$@"\n`;
        for (const name of ["pragma", "pragma-desktop"]) {
          const path = join(directory, name);
          if ((await exists(path)) && !(await readFile(path, "utf8")).includes(LAUNCHER_MARKER))
            throw new Error(
              `CLI_ENTRY_CONFLICT: ${path} belongs to another installation. Move it before repairing.`,
            );
          await atomicWrite(path, source);
        }
        for (const [path, shell] of await shellFiles())
          await updateShellConfig(path, shellPathBlock(directory, shell));
      }
      await rm(disabled, { force: true });
      lastError = undefined;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    return await inspect();
  }
  return {
    inspect: () => serialize(inspect),
    repair: () => serialize(repair),
    remove: () =>
      serialize(async () => {
        if (!installed) return await inspect();
        try {
          // Persist opt-out first; a crash or next startup must not silently reinstall.
          await atomicWrite(disabled, "");
          if (options.platform === "win32") await windowsAction("remove");
          else {
            for (const [path] of await shellFiles()) await updateShellConfig(path, undefined);
            for (const name of ["pragma", "pragma-desktop"]) {
              const path = join(directory, name);
              if ((await exists(path)) && (await readFile(path, "utf8")).includes(LAUNCHER_MARKER))
                await rm(path);
            }
          }
          lastError = undefined;
        } catch (error) {
          lastError = error instanceof Error ? error.message : String(error);
        }
        return await inspect();
      }),
    initialize: () =>
      serialize(async () => {
        if (!installed || (await exists(disabled))) return await inspect();
        // Machine registration belongs to the elevated installer, not every user startup.
        return options.platform === "win32" ? await inspect() : await repair();
      }),
  };
}
