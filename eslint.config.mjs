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
  regex:
    "^(?:@pqpo/pragma(?:/.*)?|@pragma/(?!shared(?:/integration)?$|interpreter/ast$|evaluation/ast$|built-in-agents/contracts$).+)",
  message:
    "Desktop preload, renderer, and shared code may only import browser-safe @pragma/shared, @pragma/interpreter/ast, @pragma/evaluation/ast, or @pragma/built-in-agents/contracts.",
};

const localHostReverseImportRestriction = {
  group: ["@pragma/local-host", "@pragma/local-host/*", "@pqpo/pragma", "@pqpo/pragma/*"],
  message:
    "Lower layers and adapters must not depend on the Local Host application layer or CLI surface.",
};

const desktopMainCliImportRestriction = {
  group: ["@pqpo/pragma", "@pqpo/pragma/*"],
  message: "Desktop Main must compose Local Host directly instead of importing the CLI surface.",
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
          paths: ["@pragma/core", "@pragma/evaluation", "@prisma/client"],
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
          paths: ["@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            desktopMainCliImportRestriction,
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
    files: ["apps/cli/**/*.{ts,tsx}"],
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
          paths: ["electron", "@pragma/desktop", "react", "next"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: [
                "../desktop",
                "../desktop/**",
                "../../apps/desktop/**",
                "@pragma/server-*",
                "next/*",
              ],
              message: "CLI must not depend on Desktop internals, Electron, Server, or Web UI.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/local-host/**/*.{ts,tsx}"],
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
          paths: ["electron", "@pqpo/pragma", "react", "next"],
          patterns: [
            ...commonRestrictedPatterns,
            {
              group: ["@pragma/runtime-*", "@pragma/server-*", "apps/*", "next/*"],
              message:
                "Local Host is a Node application layer and must not depend on apps, Electron, client/server, or concrete Runtime adapters.",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["apps/desktop/src/main/features/**/*.{ts,tsx}"],
    ignores: ["apps/desktop/src/main/features/**/*.test.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "@pragma/interpreter/ast",
              importNames: [
                "PragmaCapabilityResourceSchema",
                "PragmaContextStoreResourceSchema",
                "PragmaRuntimeProfileResourceSchema",
              ],
              message:
                "Desktop bound resources must be classified, created, or rebound through desktop-bound-resource-policy.ts.",
            },
          ],
          patterns: commonRestrictedPatterns,
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
    files: ["apps/desktop/src/renderer/src/pages/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "JSXOpeningElement[name.name='select']",
          message:
            "Desktop pages must use the shared SelectMenu instead of a native select control.",
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='alert']",
          message: "Desktop pages must use the shared Dialog instead of window.alert().",
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='confirm']",
          message: "Desktop pages must use the shared Dialog instead of window.confirm().",
        },
        {
          selector: "CallExpression[callee.object.name='window'][callee.property.name='prompt']",
          message: "Desktop pages must use the shared Dialog instead of window.prompt().",
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
    files: ["packages/built-in-agents/**/*.{js,mjs,ts,tsx}"],
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
          paths: ["@prisma/client", "react", "next"],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
            {
              group: ["@pragma/runtime-*", "@pragma/server-*", "apps/*", "next/*"],
              message:
                "Built-in Agents must remain portable and cannot depend on applications, Server, Web UI, or concrete Runtime adapters.",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "packages/built-in-agents/src/contracts.ts",
      "packages/built-in-agents/src/revision-contracts.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            "@pragma/core",
            "@pragma/interpreter",
            "@pragma/evaluation",
            "@pragma/memory",
            "@prisma/client",
            "react",
            "next",
          ],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
            {
              group: ["@pragma/runtime-*", "@pragma/server-*", "node:*", "next/*"],
              message: "Built-in Agent contracts must remain browser-safe.",
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
          paths: ["react", "fastify", "@prisma/client"],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
    files: ["packages/core/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["@pragma/evaluation", "@pragma/interpreter", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
          paths: ["@pragma/interpreter", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
          paths: ["react"],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
          paths: ["@pragma/runtime-codex", "@pragma/runtime-claude-code", "react"],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
            "@pragma/runtime-pi",
            "@pragma/runtime-claude-code",
            "@earendil-works/pi-coding-agent",
            "react",
          ],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
            "@pragma/runtime-pi",
            "@pragma/runtime-codex",
            "@earendil-works/pi-coding-agent",
            "react",
          ],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
    files: ["packages/runtime/antigravity/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: ["react"],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
                "Antigravity runtime packages must not depend on other runtimes or app layers.",
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
          paths: ["react"],
          patterns: [
            ...commonRestrictedPatterns,
            localHostReverseImportRestriction,
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
  {
    files: [
      "packages/memory/**/*.{ts,tsx}",
      "packages/context-filesystem/**/*.{ts,tsx}",
      "packages/runtime/qodercli/**/*.{ts,tsx}",
      "apps/server/**/*.{ts,tsx}",
      "apps/worker/**/*.{ts,tsx}",
      "examples/**/*.{ts,tsx}",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [...commonRestrictedPatterns, localHostReverseImportRestriction],
        },
      ],
    },
  },
);

export default config;
