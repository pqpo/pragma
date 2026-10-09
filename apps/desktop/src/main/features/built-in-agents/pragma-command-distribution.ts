import { access, chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { managementCommandError } from "@pragma/shared/integration";

/** Private process PATH only; never installs a user CLI or changes shell configuration. */
export async function prepareDesktopPragmaCommand(options: {
  readonly cacheRoot: string;
}): Promise<string> {
  const client = fileURLToPath(new URL("./pragma-command-client.js", import.meta.url)).replace(
    /([\\/])app\.asar([\\/])/u,
    "$1app.asar.unpacked$2",
  );
  try {
    await access(client);
  } catch {
    throw managementCommandError(
      "DEPENDENCY_UNAVAILABLE",
      "The bundled Pragma command client is missing. Rebuild or reinstall Desktop.",
    );
  }
  const directory = join(options.cacheRoot, "execution-command", "v1");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = join(directory, process.platform === "win32" ? "pragma.cmd" : "pragma");
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const source =
    process.platform === "win32"
      ? `@echo off\r\nsetlocal\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${process.execPath}" "${client}" %*\r\n`
      : `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(process.execPath)} ${quote(client)} "$@"\n`;
  const temporary = join(directory, `.pragma.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, source, { mode: 0o700 });
    await chmod(temporary, 0o700);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return dirname(target);
}
