import { defineConfig } from "vitest/config";

interface OxcTsconfigOptions {
  readonly tsconfig: {
    readonly compilerOptions: {
      readonly target: string;
      readonly verbatimModuleSyntax: boolean;
    };
  };
}

const oxcOptions: OxcTsconfigOptions = {
  tsconfig: {
    compilerOptions: {
      target: "ES2022",
      verbatimModuleSyntax: true,
    },
  },
};

export default defineConfig({
  oxc: oxcOptions as never,
  test: {
    environment: "node",
    // Core storage and runtime tests share file-system and child-process resources.
    maxWorkers: 4,
  },
});
