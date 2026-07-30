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

const desktopBrowserSafePragmaRestriction = {
  regex: "^@pragma/(?!shared$|interpreter/ast$|evaluation/ast$).+",
  message:
    "Desktop preload, renderer, and shared code may only import @pragma/shared, @pragma/interpreter/ast, or @pragma/evaluation/ast.",
};

const config = tseslint.config(
  {
    ignores: [
      "**/dist/**",
      "**/out/**",
      "**/.next/**",
      "**/coverage/**",
      "**/.plugin-bundles/**",
      "node_modules/**",
    ],
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
          paths: ["@pragma/server", "@pragma/core", "@pragma/evaluation", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            { group: ["@pragma/server-*", "node:*"], message: "Web must stay browser-safe." },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/scripts/**/*.{js,mjs,ts}", "apps/desktop/src/main/**/*.{ts,tsx,d.ts}"],
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
              group: ["@pragma/server-*", "next", "next/*"],
              message: "Desktop local bridge must not depend on server internals or Web UI.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/preload/**/*.{ts,tsx,d.ts}"],
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
          paths: ["@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            desktopBrowserSafePragmaRestriction,
            {
              group: ["node:*", "next", "next/*"],
              message: "Desktop preload must remain a browser-safe IPC bridge.",
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
          paths: ["@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            desktopBrowserSafePragmaRestriction,
            {
              group: ["node:*", "next", "next/*"],
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
          paths: ["@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            desktopBrowserSafePragmaRestriction,
            {
              group: ["node:*", "next", "next/*"],
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
      "packages/evaluation/**/*.{ts,tsx}",
      "packages/interpreter/**/*.{ts,tsx}",
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
              group: [
                "@pragma/core",
                "@pragma/interpreter",
                "@pragma/interpreter/*",
                "@pragma/evaluation",
                "@pragma/evaluation/*",
                "node:*",
                "next",
                "next/*",
              ],
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
              group: [
                "@pragma/core",
                "@pragma/evaluation",
                "@pragma/evaluation/*",
                "@pragma/server",
                "@pragma/server-*",
                "node:*",
              ],
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
          paths: [
            "@pragma/client",
            "@pragma/evaluation",
            "@pragma/interpreter",
            "@pragma/server",
            "react",
          ],
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
    files: ["packages/evaluation/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@pragma/client", "@pragma/interpreter", "@pragma/server", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/runtime-*", "@pragma/server-*", "@pragma/ui-*", "next", "next/*"],
              message:
                "Evaluation may depend on Core abstractions, not Interpreter, concrete runtimes, or app layers.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/interpreter/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@pragma/client", "@pragma/server", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/runtime-*", "@pragma/server-*", "@pragma/ui-*", "next", "next/*"],
              message:
                "Interpreter may depend on Core execution abstractions, not concrete runtimes or app layers.",
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
          paths: [
            "@pragma/client",
            "@pragma/server",
            "@pragma/runtime-codex",
            "@pragma/runtime-claude-code",
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
            "@pragma/runtime-claude-code",
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
    files: ["packages/runtime/claude-code/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@pragma/client",
            "@pragma/server",
            "@pragma/runtime-pi",
            "@pragma/runtime-codex",
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
              message:
                "Claude Code runtime packages must not depend on other runtimes or app layers.",
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
