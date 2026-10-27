import { loadDistribution } from "../../../scripts/distribution.mjs";
import { recordArtifact } from "../../../scripts/build-artifact.mjs";
import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildCliBundles, CLI_WORKERS } from "./build-bundles.mjs";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const distDirectory = join(packageDirectory, "dist");
const releaseDirectory = join(packageDirectory, ".release");
const stagingDirectory = join(releaseDirectory, "package");
const packageManifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
const profile = await loadDistribution();
const { config: distribution, digest: distributionDigest } = profile;
const version = distribution.cliVersion ?? packageManifest.version;
if (packageManifest.name !== "@pqpo/pragma") {
  throw new Error(`Unexpected CLI package name: ${String(packageManifest.name)}.`);
}
if (typeof version !== "string" || !isReleaseVersion(version)) {
  throw new Error(`CLI package version must be a release semver, received ${String(version)}.`);
}

await rm(distDirectory, { recursive: true, force: true });
await rm(releaseDirectory, { recursive: true, force: true });
await mkdir(distDirectory, { recursive: true });
await mkdir(join(stagingDirectory, "dist"), { recursive: true });

const bundles = await buildCliBundles({
  outputDirectory: distDirectory,
  version,
  distribution: profile,
});
await chmod(join(distDirectory, "pragma.js"), 0o755);
for (const [name, result] of Object.entries(bundles)) {
  await writeFile(
    join(releaseDirectory, `${name}.metafile.json`),
    `${JSON.stringify(result.metafile, null, 2)}\n`,
    "utf8",
  );
}

await Promise.all([
  ...["pragma", "cli", ...Object.keys(CLI_WORKERS)].map((name) =>
    cp(join(distDirectory, `${name}.js`), join(stagingDirectory, "dist", `${name}.js`)),
  ),
  cp(join(packageDirectory, "README.md"), join(stagingDirectory, "README.md")),
  cp(join(repositoryDirectory, "LICENSE"), join(stagingDirectory, "LICENSE")),
  cp(
    join(packageDirectory, "THIRD_PARTY_NOTICES.txt"),
    join(stagingDirectory, "THIRD_PARTY_NOTICES.txt"),
  ),
]);
await writeFile(
  join(stagingDirectory, "package.json"),
  `${JSON.stringify(createReleaseManifest(version), null, 2)}\n`,
  "utf8",
);

await recordArtifact("cli");

console.log(`Built @pqpo/pragma ${version}.`);
console.log(`Staging package: ${stagingDirectory}`);

function createReleaseManifest(releaseVersion) {
  return {
    name: distribution.cliPackageName,
    pragmaDistribution: { id: distribution.id, digest: distributionDigest },
    version: releaseVersion,
    description: "Pragma command-line interface",
    license: "AGPL-3.0-only",
    type: "module",
    bin: { [distribution.cliCommand]: "./dist/pragma.js" },
    exports: {},
    engines: { node: ">=22" },
    os: ["darwin", "win32"],
    files: ["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
    dependencies: {
      "@napi-rs/keyring": packageManifest.dependencies["@napi-rs/keyring"],
      "@silvia-odwyer/photon-node": packageManifest.dependencies["@silvia-odwyer/photon-node"],
    },
    publishConfig:
      distribution.id === "pragma"
        ? { access: "public", registry: "https://registry.npmjs.org" }
        : { access: "restricted" },
    repository: {
      type: "git",
      url: "git+https://github.com/pqpo/pragma.git",
      directory: "apps/cli",
    },
    homepage: "https://github.com/pqpo/pragma#readme",
    bugs: { url: "https://github.com/pqpo/pragma/issues" },
    keywords: ["pragma", "cli", "agent"],
  };
}

function isReleaseVersion(value) {
  return /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.test(
    value,
  );
}
