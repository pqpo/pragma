import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

export default defineConfig({
  main: {
    build: {
      externalizeDeps: {
        exclude: [
          "@pragma/runtime-claude-code",
          "@pragma/runtime-codex",
          "@pragma/runtime-pi",
          "@pragma/core",
          "@pragma/interpreter",
          "@pragma/shared",
          "@pragma/default-agent",
        ],
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
