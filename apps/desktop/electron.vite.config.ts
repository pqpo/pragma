import react from "@vitejs/plugin-react";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@pragma/runtime-claude-code",
          "@pragma/runtime-codex",
          "@pragma/runtime-pi",
          "@pragma/core",
          "@pragma/interpreter",
          "@pragma/shared",
        ],
      }),
    ],
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
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
