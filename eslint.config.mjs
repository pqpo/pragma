import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const packageRelativeImportMessage =
  "Cross-package imports must use @expertmesh/* package names instead of relative paths.";

const commonRestrictedPatterns = [
  {
    group: ["../**/packages/**", "../../**/packages/**", "../../../**/packages/**"],
    message: packageRelativeImportMessage,
  },
];

const config = tseslint.config(
  {
    ignores: ["**/dist/**", "**/out/**", "**/.next/**", "**/coverage/**", "node_modules/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: commonRestrictedPatterns,
        },
      ],
    },
  },
  {
    files: ["apps/web/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2023,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@expertmesh/database", "@expertmesh/agent-core", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            { group: ["@expertmesh/server-*", "node:*"], message: "Web must stay browser-safe." },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/main/**/*.{ts,tsx,d.ts}", "apps/desktop/src/preload/**/*.{ts,tsx,d.ts}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@expertmesh/sdk", "@expertmesh/database", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@expertmesh/server-*", "next", "next/*"],
              message: "Desktop local bridge must not depend on server internals or Web UI.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.{ts,tsx,d.ts}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2023,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@expertmesh/sdk", "@expertmesh/database", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@expertmesh/server-*", "node:*", "next", "next/*"],
              message: "Desktop renderer must stay behind the preload bridge.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/shared/**/*.{ts,tsx,d.ts}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@expertmesh/sdk", "@expertmesh/database", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@expertmesh/server-*", "node:*", "next", "next/*"],
              message:
                "Desktop shared types must be safe for all layers (main, preload, renderer).",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/server/**/*.{ts,tsx}",
      "apps/worker/**/*.{ts,tsx}",
      "packages/server/**/*.{ts,tsx}",
      "packages/agent/**/*.{ts,tsx}",
      "plugins/**/*.{ts,tsx}",
      "examples/**/*.{ts,tsx}",
    ],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.es2023,
      },
    },
  },
  {
    files: ["packages/shared/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@expertmesh/sdk", "@expertmesh/database", "react", "fastify", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@expertmesh/agent-*", "node:*", "next", "next/*"],
              message: "Shared packages must remain runtime-neutral.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/client/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.es2023,
      },
    },
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@expertmesh/database", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@expertmesh/agent-*", "@expertmesh/server-*", "node:*"],
              message: "Client packages must stay browser-safe.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/server/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@expertmesh/sdk", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@expertmesh/ui-*", "@expertmesh/playbook-canvas", "next", "next/*"],
              message: "Server packages must not depend on client UI.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/agent/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@expertmesh/sdk", "@expertmesh/database", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: [
                "@expertmesh/server-*",
                "@expertmesh/ui-*",
                "@expertmesh/playbook-canvas",
                "next",
                "next/*",
              ],
              message: "Agent packages must not depend on server internals or client UI.",
            },
          ],
        },
      ],
    },
  },
);

export default config;
