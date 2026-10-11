import { existsSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, mergeConfig } from "vitest/config";
import base from "./vitest.config.ts";

const sourceRoot = fileURLToPath(new URL("./src/", import.meta.url));
const outputRoot = fileURLToPath(new URL("./dist/", import.meta.url));

// Test the production module graph, including ordinary JS Worker entry points.
// Mock resolution uses the same mapping as application resolution.
export default mergeConfig(
  base,
  defineConfig({
    test: {
      setupFiles: ["./test/compiled-workers.setup.ts"],
      fsModuleCache: true,
    },
    plugins: [
      {
        name: "compiled-local-host-integration",
        enforce: "pre",
        resolveId(source, importer) {
          if (
            !importer ||
            !source.endsWith(".ts") ||
            (!source.startsWith(".") && !source.startsWith("/"))
          )
            return;
          const path = resolve(dirname(importer.split("?")[0]!), source);
          const member = relative(sourceRoot, path);
          if (member.startsWith(`..${sep}`) || member === ".." || member.startsWith(sep)) return;
          const compiled = resolve(outputRoot, member.replace(/\.ts$/, ".js"));
          if (!existsSync(compiled))
            throw new Error(
              `Missing integration build: ${compiled}. Run the test preparation command first.`,
            );
          return compiled;
        },
      },
    ],
  }),
);
