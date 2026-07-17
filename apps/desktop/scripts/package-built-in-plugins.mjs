import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const pluginsRoot = join(repositoryRoot, "plugins");
const outputRoot = join(desktopRoot, ".plugin-bundles", "plugins");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const pluginDirectories = (await readdir(pluginsRoot, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(pluginsRoot, entry.name));

for (const pluginDirectory of pluginDirectories) {
  const manifestPath = join(pluginDirectory, "plugin.json");
  let manifest;
  try {
    manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") continue;
    throw error;
  }
  if (manifest.schemaVersion !== "pragma.plugin/v2") {
    throw new Error(`Built-in plugin must use pragma.plugin/v2: ${manifestPath}`);
  }
  const sourceEntry = join(pluginDirectory, "src", "index.ts");
  const targetDirectory = join(outputRoot, manifest.id, manifest.version);
  await mkdir(targetDirectory, { recursive: true });
  await build({
    entryPoints: [sourceEntry],
    outfile: join(targetDirectory, "index.mjs"),
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node22",
    sourcemap: false,
    treeShaking: true,
    packages: "bundle",
    banner: {
      js: 'import { createRequire as __pragmaCreateRequire } from "node:module"; const require = __pragmaCreateRequire(import.meta.url);',
    },
  });
  const packagedManifest = {
    ...manifest,
    runtime: { ...manifest.runtime, entry: "./index.mjs" },
  };
  await writeFile(
    join(targetDirectory, "plugin.json"),
    `${JSON.stringify(packagedManifest, null, 2)}\n`,
  );
  await writeFile(
    join(targetDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: `@pragma/built-in-${manifest.id}`,
        version: manifest.version,
        private: true,
        type: "module",
      },
      null,
      2,
    )}\n`,
  );
}
