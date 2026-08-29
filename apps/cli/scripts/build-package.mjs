import { chmod, cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryDirectory = resolve(packageDirectory, "../..");
const sourceDirectory = join(packageDirectory, "src");
const distDirectory = join(packageDirectory, "dist");
const releaseDirectory = join(packageDirectory, ".release");
const stagingDirectory = join(releaseDirectory, "package");
const packageManifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
const version = packageManifest.version;
const requireShim =
  'import { createRequire as __pragmaCreateRequire } from "node:module";\n' +
  "const require = __pragmaCreateRequire(import.meta.url);";

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

const commonBuildOptions = {
  absWorkingDir: repositoryDirectory,
  bundle: true,
  charset: "utf8",
  external: ["@napi-rs/keyring", "bufferutil", "utf-8-validate"],
  format: "esm",
  legalComments: "eof",
  logLevel: "info",
  metafile: true,
  platform: "node",
  sourcemap: false,
  target: "node22",
  banner: {
    js: requireShim,
  },
};

const mainBundle = await build({
  ...commonBuildOptions,
  define: { __PRAGMA_CLI_VERSION__: JSON.stringify(version) },
  entryPoints: [join(sourceDirectory, "index.ts")],
  outfile: join(distDirectory, "cli.js"),
});

const workerBundle = await build({
  ...commonBuildOptions,
  entryPoints: [join(repositoryDirectory, "packages/core/src/code-service-worker.ts")],
  outfile: join(distDirectory, "code-service-worker.js"),
});

await build({
  absWorkingDir: repositoryDirectory,
  bundle: false,
  charset: "utf8",
  entryPoints: [join(sourceDirectory, "pragma.ts")],
  format: "esm",
  logLevel: "info",
  outfile: join(distDirectory, "pragma.js"),
  platform: "node",
  sourcemap: false,
  target: "node22",
});
await chmod(join(distDirectory, "pragma.js"), 0o755);

await writeFile(
  join(releaseDirectory, "cli.metafile.json"),
  `${JSON.stringify(mainBundle.metafile, null, 2)}\n`,
  "utf8",
);
await writeFile(
  join(releaseDirectory, "code-service-worker.metafile.json"),
  `${JSON.stringify(workerBundle.metafile, null, 2)}\n`,
  "utf8",
);

await Promise.all([
  cp(join(distDirectory, "pragma.js"), join(stagingDirectory, "dist/pragma.js")),
  cp(join(distDirectory, "cli.js"), join(stagingDirectory, "dist/cli.js")),
  cp(
    join(distDirectory, "code-service-worker.js"),
    join(stagingDirectory, "dist/code-service-worker.js"),
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

console.log(`Built @pqpo/pragma ${version}.`);
console.log(`Staging package: ${stagingDirectory}`);

function createReleaseManifest(releaseVersion) {
  return {
    name: "@pqpo/pragma",
    version: releaseVersion,
    description: "Pragma command-line interface",
    license: "SEE LICENSE IN LICENSE",
    type: "module",
    bin: { pragma: "./dist/pragma.js" },
    exports: {},
    engines: { node: ">=22" },
    os: ["darwin", "win32"],
    files: ["dist", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.txt"],
    dependencies: { "@napi-rs/keyring": "1.3.0" },
    publishConfig: {
      access: "public",
      registry: "https://registry.npmjs.org",
    },
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
