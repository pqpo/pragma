import { build } from "esbuild";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_WORKERS = {
  "code-service-worker": "packages/core/src/code-service-worker.ts",
  "canonical-event-feed-worker": "packages/core/src/events/canonical-event-feed-worker.ts",
  "vector-worker": "packages/memory/src/retrieval/vector-worker.ts",
  "claude-acp-worker": "packages/runtime/claude-code/src/claude-acp-worker.ts",
  "sqlite-execution-worker": "packages/local-host/src/execution/sqlite-execution-worker.ts",
};
const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));

/** One artifact graph for npm and Desktop; native dependencies are supplied by the distributor. */
export async function buildCliBundles({ outputDirectory, version }) {
  await mkdir(outputDirectory, { recursive: true });
  const common = {
    absWorkingDir: repositoryDirectory,
    bundle: true,
    charset: "utf8",
    external: ["@napi-rs/keyring", "bufferutil", "utf-8-validate"],
    format: "esm",
    legalComments: "eof",
    logLevel: "info",
    metafile: true,
    platform: "node",
    target: "node22",
    banner: {
      js: 'import { createRequire as __pragmaCreateRequire } from "node:module"; const require = __pragmaCreateRequire(import.meta.url);',
    },
  };
  const results = {};
  for (const [name, source] of Object.entries({ cli: "apps/cli/src/index.ts", ...CLI_WORKERS })) {
    results[name] = await build({
      ...common,
      define: { __PRAGMA_CLI_VERSION__: JSON.stringify(version) },
      entryPoints: [join(repositoryDirectory, source)],
      outfile: join(outputDirectory, `${name}.js`),
    });
  }
  await build({
    ...common,
    bundle: false,
    external: undefined,
    metafile: false,
    banner: undefined,
    entryPoints: [join(repositoryDirectory, "apps/cli/src/pragma.ts")],
    outfile: join(outputDirectory, "pragma.js"),
  });
  await writeFile(join(outputDirectory, "package.json"), JSON.stringify({ type: "module" }) + "\n");
  return results;
}
