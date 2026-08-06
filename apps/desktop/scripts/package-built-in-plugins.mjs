import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "esbuild";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = resolve(desktopRoot, "../..");
const pluginsRoot = join(repositoryRoot, "plugins");
const outputRoot = join(desktopRoot, ".plugin-bundles", "plugins");

await rm(outputRoot, { recursive: true, force: true });
await mkdir(outputRoot, { recursive: true });

const pluginEntries = await readdir(pluginsRoot, { withFileTypes: true }).catch((error) => {
  if (error?.code === "ENOENT") return [];
  throw error;
});
const pluginDirectories = pluginEntries
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
  const targetEntry = join(targetDirectory, "src", "index.mjs");
  await mkdir(dirname(targetEntry), { recursive: true });
  await build({
    entryPoints: [sourceEntry],
    outfile: targetEntry,
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
    runtime: { ...manifest.runtime, entry: "./src/index.mjs" },
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
  const packagedModule = await import(
    `${pathToFileURL(targetEntry).href}?packageFingerprint=${Date.now()}`
  );
  if (JSON.stringify(packagedModule.default?.manifest) !== JSON.stringify(packagedManifest)) {
    throw new Error(`Built-in plugin export manifest does not match its package: ${manifest.id}`);
  }
}
