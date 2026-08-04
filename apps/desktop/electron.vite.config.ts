import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

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
    build: {
      externalizeDeps: {
        exclude: workspaceDependencies,
      },
      rollupOptions: {
        input: {
          index: fileURLToPath(new URL("./src/main/index.ts", import.meta.url)),
          "code-service-worker": fileURLToPath(
            new URL("../../packages/core/src/code-service-worker.ts", import.meta.url),
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
