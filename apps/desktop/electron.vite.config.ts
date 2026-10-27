// @ts-expect-error Build-only JavaScript helper shared with npm packaging.
import { buildDesktopCli, RUNTIME_RESOURCE_EXTERNALS } from "./scripts/build-desktop-cli.mjs";
// @ts-expect-error Build-only shared configuration loader.
import { loadDistribution, distributionBanner } from "../../scripts/distribution.mjs";
import { build } from "esbuild";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

interface DesktopPackageManifest {
  readonly version: string;
  readonly dependencies?: Readonly<Record<string, string>>;
}

const distributionProfile = await loadDistribution();
const { config: distribution } = distributionProfile;

const desktopPackageManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as DesktopPackageManifest;
const workspaceDependencies = Object.entries(desktopPackageManifest.dependencies ?? {})
  .filter(([, version]) => version.startsWith("workspace:"))
  .map(([name]) => name);

export default defineConfig(({ command }) => ({
  main: {
    define: { __PRAGMA_BUILD_DISTRIBUTION__: JSON.stringify(distribution) },
    esbuild: { keepNames: true, legalComments: "eof" },
    plugins: [
      {
        name: "bundle-claude-acp-worker",
        async writeBundle(output) {
          if (output.dir === undefined)
            throw new Error("Desktop main output directory is missing.");
          await writeFile(
            join(output.dir, "distribution.json"),
            JSON.stringify({
              distributionId: distribution.id,
              distributionDigest: distributionProfile.digest,
              desktopVersion: distribution.desktopVersion ?? desktopPackageManifest.version,
            }) + "\n",
          );
          await buildDesktopCli(output.dir, {
            distribution: distributionProfile,
            minify: command === "build" && process.env.PRAGMA_BUILD_MINIFY !== "0",
            development: command === "serve",
          });
          // A self-contained worker requires only this file outside ASAR, without
          // changing the packaging policy for main or its shared chunks.
          await build({
            entryPoints: [fileURLToPath(new URL("../cli/src/managed-pragma.ts", import.meta.url))],
            outfile: join(output.dir, "pragma-command-client.js"),
            bundle: true,
            minify: command === "build" && process.env.PRAGMA_BUILD_MINIFY !== "0",
            keepNames: true,
            platform: "node",
            target: "node22",
            format: "esm",
            banner: {
              js: 'import { createRequire as __pragmaCreateRequire } from "node:module"; const require = __pragmaCreateRequire(import.meta.url);',
            },
          });
          await build({
            entryPoints: [
              fileURLToPath(
                new URL(
                  "../../packages/runtime/claude-code/src/claude-acp-worker.ts",
                  import.meta.url,
                ),
              ),
            ],
            outfile: join(output.dir, "claude-acp-worker.js"),
            bundle: true,
            minify: command === "build" && process.env.PRAGMA_BUILD_MINIFY !== "0",
            keepNames: true,
            platform: "node",
            target: "node22",
            format: "esm",
            external: ["@napi-rs/keyring", "bufferutil", "utf-8-validate"],
            banner: {
              js: 'import { createRequire as __pragmaCreateRequire } from "node:module"; const require = __pragmaCreateRequire(import.meta.url);',
            },
          });
        },
      },
    ],
    build: {
      minify: command === "build" && process.env.PRAGMA_BUILD_MINIFY !== "0" ? "esbuild" : false,
      externalizeDeps: {
        // predev builds workspace dist first. Load those packages through Node in
        // development instead of rebundling every Runtime SDK on each launch.
        // Distribution builds still include the complete workspace dependency graph.
        exclude: command === "serve" ? [] : workspaceDependencies,
      },
      rollupOptions: {
        output: { banner: distributionBanner(distribution) },
        // ws treats these native accelerators as optional and catches a missing
        // require at runtime. Keep that fallback intact when Vite bundles ws.
        // Photon must keep its CommonJS entry beside photon_rs_bg.wasm.
        external: [...RUNTIME_RESOURCE_EXTERNALS, "bufferutil", "utf-8-validate"],
        input: {
          index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)),
          "storage-capacity-worker": fileURLToPath(
            new URL("../../packages/core/src/storage/storage-capacity-worker.ts", import.meta.url),
          ),
          "vector-worker": fileURLToPath(
            new URL("../../packages/memory/src/retrieval/vector-worker.ts", import.meta.url),
          ),
          "code-service-worker": fileURLToPath(
            new URL("../../packages/core/src/code-service-worker.ts", import.meta.url),
          ),
          "sqlite-execution-worker": fileURLToPath(
            new URL(
              "../../packages/local-host/src/execution/sqlite-execution-worker.ts",
              import.meta.url,
            ),
          ),
          "canonical-event-feed-worker": fileURLToPath(
            new URL(
              "../../packages/core/src/events/canonical-event-feed-worker.ts",
              import.meta.url,
            ),
          ),
        },
      },
    },
  },
  preload: {
    build: {
      externalizeDeps: false,
    },
  },
  renderer: {
    server: {
      port: Number(process.env.DESKTOP_RENDERER_PORT) || 5174,
      strictPort: true,
    },
    resolve: {
      dedupe: ["react", "react-dom"],
    },
    plugins: [react()],
  },
}));
