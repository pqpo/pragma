import { defineConfig } from "vitest/config";

const oxcOptions = {
  tsconfig: {
    compilerOptions: { target: "ES2022", verbatimModuleSyntax: true },
  },
};

export default defineConfig({
  oxc: oxcOptions as never,
  test: { environment: "node" },
});
