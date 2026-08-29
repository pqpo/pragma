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
  test: {
    environment: "node",
    // SQLite and child-process integration tests share host resources.
    fileParallelism: false,
  },
});
