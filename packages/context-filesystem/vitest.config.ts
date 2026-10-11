import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    tsconfig: {
      compilerOptions: {
        target: "ES2022",
        verbatimModuleSyntax: true,
      },
    },
  } as never,
  test: { maxWorkers: 2, environment: "node" },
});
