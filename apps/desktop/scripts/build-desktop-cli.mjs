import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliBundles } from "../../cli/scripts/build-bundles.mjs";

export async function buildDesktopCli(mainDirectory) {
  const cliPackage = JSON.parse(
    await readFile(new URL("../../cli/package.json", import.meta.url), "utf8"),
  );
  const desktopPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: fileURLToPath(new URL("../../../", import.meta.url)),
    encoding: "utf8",
  }).trim();
  const directory = join(mainDirectory, "desktop-cli");
  await buildCliBundles({ outputDirectory: directory, version: cliPackage.version });
  await writeFile(
    join(directory, "distribution.json"),
    JSON.stringify(
      {
        cliVersion: cliPackage.version,
        desktopVersion: desktopPackage.version,
        sourceCommit,
      },
      null,
      2,
    ) + "\n",
  );
}
