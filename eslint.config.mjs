import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

const packageRelativeImportMessage =
  "Cross-package imports must use @pragma/* package names instead of relative paths.";

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
          paths: ["@pragma/server", "@pragma/core", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            { group: ["@pragma/server-*", "node:*"], message: "Web must stay browser-safe." },
          ],
        },
      ],
    },
  },
  {
    files: [
      "apps/desktop/src/main/**/*.{ts,tsx,d.ts}",
      "apps/desktop/src/preload/**/*.{ts,tsx,d.ts}",
    ],
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
          paths: ["@pragma/client", "@pragma/server", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/runtime-*", "@pragma/server-*", "next", "next/*"],
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
          paths: ["@pragma/client", "@pragma/core", "@pragma/server", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/runtime-*", "@pragma/server-*", "node:*", "next", "next/*"],
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
          paths: ["@pragma/client", "@pragma/server", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/runtime-*", "@pragma/server-*", "node:*", "next", "next/*"],
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
      "packages/core/**/*.{ts,tsx}",
      "packages/runtime/**/*.{ts,tsx}",
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
          paths: ["@pragma/client", "@pragma/server", "react", "fastify", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/core", "node:*", "next", "next/*"],
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
          paths: ["@pragma/server", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/core", "@pragma/server", "@pragma/server-*", "node:*"],
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
          paths: ["@pragma/client", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/ui-*", "@pragma/playbook-canvas", "next", "next/*"],
              message: "Server packages must not depend on client UI.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@pragma/client", "@pragma/server", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: [
                "@pragma/runtime-*",
                "@pragma/server-*",
                "@pragma/ui-*",
                "@pragma/playbook-canvas",
                "@earendil-works/pi-coding-agent",
                "next",
                "next/*",
              ],
              message:
                "Core agent packages must not depend on concrete runtimes, server internals, or client UI.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/runtime/pi/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@pragma/client", "@pragma/server", "@pragma/runtime-codex", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: [
                "@pragma/server-*",
                "@pragma/ui-*",
                "@pragma/playbook-canvas",
                "next",
                "next/*",
              ],
              message: "PI runtime packages must not depend on other runtimes or app layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/runtime/codex/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@pragma/client",
            "@pragma/server",
            "@pragma/runtime-pi",
            "@earendil-works/pi-coding-agent",
            "react",
          ],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: [
                "@pragma/server-*",
                "@pragma/ui-*",
                "@pragma/playbook-canvas",
                "next",
                "next/*",
              ],
              message: "Codex runtime packages must not depend on other runtimes or app layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["plugins/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@pragma/client", "@pragma/server", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: [
                "@pragma/runtime-*",
                "@pragma/server-*",
                "@pragma/ui-*",
                "@pragma/playbook-canvas",
                "next",
                "next/*",
              ],
              message:
                "Plugins must depend on core plugin APIs, not app, server, client, or runtime layers.",
            },
          ],
        },
      ],
    },
  },
);

export default config;
