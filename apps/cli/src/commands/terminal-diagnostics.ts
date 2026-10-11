import { access, readFile, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { detectInstalledDesktopVersion } from "../desktop-version.ts";

/** Human diagnostics only: never add local paths to the versioned wire envelope. */
export async function terminalDiagnostics(cliVersion: string): Promise<string> {
  const entry = resolve(process.argv[1] ?? process.execPath);
  const bundled = entry.includes(
    `${process.platform === "win32" ? "\\" : "/"}desktop-cli${process.platform === "win32" ? "\\" : "/"}`,
  );
  const candidates = new Set<string>();
  const names =
    process.platform === "win32" ? ["pragma.exe", "pragma.cmd", "pragma.bat"] : ["pragma"];
  for (const directory of (process.env["PATH"] ?? "").split(delimiter).slice(0, 256)) {
    for (const name of names) {
      const path = resolve(directory || ".", name);
      try {
        await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
        if ((await stat(path)).isFile()) candidates.add(path);
      } catch {
        /* Missing or inaccessible executable. */
      }
    }
  }
  const commandDirectory =
    process.platform === "win32"
      ? join(dirname(process.execPath), "bin")
      : join(homedir(), ".pragma", "bin");
  let registered = candidates.has(
    join(commandDirectory, process.platform === "win32" ? "pragma.cmd" : "pragma"),
  );
  if (process.platform === "win32") {
    for (const path of candidates) {
      try {
        registered ||= (await readFile(join(dirname(path), "pragma-desktop.cmd"), "utf8")).includes(
          "rem Pragma Desktop CLI launcher",
        );
      } catch {
        /* Not a Desktop entrypoint. */
      }
    }
  }
  let desktopVersion = (await detectInstalledDesktopVersion()) ?? "unknown";
  if (bundled) {
    try {
      desktopVersion = (
        JSON.parse(await readFile(join(dirname(entry), "distribution.json"), "utf8")) as {
          desktopVersion: string;
        }
      ).desktopVersion;
    } catch {
      /* Existing detector remains available. */
    }
  }
  return `CLI: ${cliVersion} (${bundled ? "Desktop bundle" : "standalone"})\nExecutable: ${process.execPath}\nEntry: ${entry}\nDesktop: ${desktopVersion}\nTerminal integration: ${registered ? "on PATH" : "not on this process PATH; open a new terminal or repair in Desktop Settings"}\nPragma commands on PATH:\n${[...candidates].map((path, index) => `  ${index === 0 ? "[first] " : ""}${path}`).join("\n") || "  none"}\n`;
}
