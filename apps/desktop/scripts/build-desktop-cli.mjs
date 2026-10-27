import { loadDistribution } from "../../../scripts/distribution.mjs";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCliBundles } from "../../cli/scripts/build-bundles.mjs";

export { RUNTIME_RESOURCE_EXTERNALS } from "../../cli/scripts/build-bundles.mjs";

export function resolveDesktopSourceCommit(repositoryDirectory, { development = false } = {}) {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryDirectory,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (cause) {
    // Source archives have no Git metadata. Only development may omit provenance.
    if (development) return null;
    throw new Error("Desktop builds require a Git checkout with a valid HEAD.", { cause });
  }
}

export async function buildDesktopCli(
  mainDirectory,
  { minify = true, development = false, distribution } = {},
) {
  const profile = distribution ?? (await loadDistribution());
  const { config, digest } = profile;
  const cliPackage = JSON.parse(
    await readFile(new URL("../../cli/package.json", import.meta.url), "utf8"),
  );
  const desktopPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const sourceCommit = resolveDesktopSourceCommit(
    fileURLToPath(new URL("../../../", import.meta.url)),
    { development },
  );
  const directory = join(mainDirectory, "desktop-cli");
  const bundles = await buildCliBundles({
    outputDirectory: directory,
    version: cliPackage.version,
    minify,
    distribution: profile,
  });
  const evidenceDirectory = fileURLToPath(new URL("../.packaging/", import.meta.url));
  await mkdir(evidenceDirectory, { recursive: true });
  await writeFile(
    join(evidenceDirectory, "cli-metafiles.json"),
    JSON.stringify(
      Object.fromEntries(Object.entries(bundles).map(([name, result]) => [name, result.metafile])),
      null,
      2,
    ) + "\n",
  );
  await writeFile(
    join(directory, "distribution.json"),
    JSON.stringify(
      {
        cliVersion: config.cliVersion ?? cliPackage.version,
        desktopVersion: config.desktopVersion ?? desktopPackage.version,
        distributionId: config.id,
        distributionDigest: digest,
        sourceCommit,
      },
      null,
      2,
    ) + "\n",
  );
}
