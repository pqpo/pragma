import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { build } from "esbuild";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

interface DesktopPackageManifest {
  readonly dependencies?: Readonly<Record<string, string>>;
}

const desktopPackageManifest = JSON.parse(
  readFileSync(fileURLToPath(new URL("./package.json", import.meta.url)), "utf8"),
) as DesktopPackageManifest;
const workspaceDependencies = Object.entries(desktopPackageManifest.dependencies ?? {})
  .filter(([, version]) => version.startsWith("workspace:"))
  .map(([name]) => name);

export default defineConfig({
  main: {
    plugins: [
      {
        name: "bundle-claude-acp-worker",
        async writeBundle(output) {
          if (output.dir === undefined)
            throw new Error("Desktop main output directory is missing.");
          // A self-contained worker requires only this file outside ASAR, without
          // changing the packaging policy for main or its shared chunks.
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
      externalizeDeps: {
        exclude: workspaceDependencies,
      },
      rollupOptions: {
        // ws treats these native accelerators as optional and catches a missing
        // require at runtime. Keep that fallback intact when Vite bundles ws.
        external: ["@napi-rs/keyring", "bufferutil", "utf-8-validate"],
        input: {
          index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)),
          "vector-worker": fileURLToPath(
            new URL("../../packages/memory/src/retrieval/vector-worker.ts", import.meta.url),
          ),
          "code-service-worker": fileURLToPath(
            new URL("../../packages/core/src/code-service-worker.ts", import.meta.url),
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
});
