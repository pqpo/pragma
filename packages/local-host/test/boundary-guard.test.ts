import { ESLint } from "eslint";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const workspaceRoot = fileURLToPath(new URL("../../..", import.meta.url));
const dependencyBuckets = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;

type DependencyBucket = (typeof dependencyBuckets)[number];
type PackageManifest = Partial<Record<DependencyBucket, Readonly<Record<string, string>>>>;
type InternalDependencyAllowlist = Readonly<Record<DependencyBucket, readonly string[]>>;

const localHostInternalDependencyAllowlist: InternalDependencyAllowlist = {
  dependencies: [
    "@pragma/built-in-agents",
    "@pragma/context-filesystem",
    "@pragma/core",
    "@pragma/evaluation",
    "@pragma/interpreter",
    "@pragma/memory",
    "@pragma/shared",
  ],
  devDependencies: ["@pragma/tsconfig"],
  optionalDependencies: [],
  peerDependencies: [],
};

const cliInternalDependencyAllowlist: InternalDependencyAllowlist = {
  dependencies: [
    "@pragma/local-host",
    "@pragma/shared",
    "@pragma/runtime-antigravity",
    "@pragma/runtime-claude-code",
    "@pragma/runtime-codex",
    "@pragma/runtime-opencode",
    "@pragma/runtime-pi",
    "@pragma/runtime-qodercli",
  ],
  devDependencies: ["@pragma/tsconfig"],
  optionalDependencies: [],
  peerDependencies: [],
};

function manifestBoundaryViolations(
  manifest: PackageManifest,
  allowlist: InternalDependencyAllowlist,
): string[] {
  const violations: string[] = [];

  for (const bucket of dependencyBuckets) {
    for (const expectedName of allowlist[bucket]) {
      if (manifest[bucket]?.[expectedName] === undefined) {
        violations.push(`${bucket} must include ${expectedName}`);
      }
    }
    for (const [name, version] of Object.entries(manifest[bucket] ?? {})) {
      if (!name.startsWith("@pragma/")) continue;

      if (!allowlist[bucket].includes(name)) {
        violations.push(`${bucket} must not include ${name}`);
      }
      if (version !== "workspace:*") {
        violations.push(`${bucket}.${name} must use workspace:*`);
      }
    }
  }

  return violations;
}

function manifestDependencyNames(manifest: PackageManifest): string[] {
  return dependencyBuckets.flatMap((bucket) => Object.keys(manifest[bucket] ?? {}));
}

const eslint = new ESLint({ cwd: workspaceRoot });
async function lintStdin(source: string, filename: string): Promise<string> {
  const results = await eslint.lintText(source, { filePath: filename });
  return results.flatMap((result) => result.messages.map((message) => message.message)).join("\n");
}

describe("Local Host boundary guards", () => {
  it("keeps deployment contracts browser-safe while exposing only their safe renderer entry", async () => {
    const file = "packages/local-host/src/deployment-contracts/boundary.ts";
    for (const dependency of [
      "node:fs",
      "fs",
      "@pragma/core",
      "@pragma/local-host/deployment",
      "../deployment/index.ts",
      "./nested/../../deployment/index.ts",
    ]) {
      expect(await lintStdin(`import ${JSON.stringify(dependency)};\n`, file)).toContain(
        "Deployment contracts must remain browser-safe",
      );
    }
    for (const dependency of [
      "zod",
      "@pragma/shared",
      "@pragma/interpreter/ast",
      "@pragma/built-in-agents/contracts",
      "./bundles.ts",
    ]) {
      expect(await lintStdin(`import ${JSON.stringify(dependency)};\n`, file)).toBe("");
    }
    expect(
      await lintStdin(
        'import "@pragma/local-host/deployment-contracts";\n',
        "apps/desktop/src/renderer/legal.ts",
      ),
    ).toBe("");
    expect(
      await lintStdin(
        'import "@pragma/local-host/deployment";\n',
        "apps/desktop/src/renderer/illegal.ts",
      ),
    ).toContain("Desktop preload, renderer, and shared code");
  });

  it("rejects a concrete Runtime import from Local Host", async () => {
    expect(
      await lintStdin('import "@pragma/runtime-codex";\n', "packages/local-host/src/illegal.ts"),
    ).toContain("Local Host is a Node application layer");
  });

  it("rejects Local Host and CLI imports that cross their composition boundaries", async () => {
    expect(
      await lintStdin(
        'import "@pragma/local-host";\n',
        "packages/runtime/antigravity/src/illegal.ts",
      ),
    ).toContain("Lower layers and adapters must not depend");
    expect(
      await lintStdin('import "@pqpo/pragma";\n', "packages/runtime/antigravity/src/illegal.ts"),
    ).toContain("Lower layers and adapters must not depend");
    expect(
      await lintStdin('import "@pqpo/pragma/internal";\n', "apps/desktop/src/main/illegal.ts"),
    ).toContain("Desktop Main must compose Local Host directly");
    expect(
      await lintStdin('import "@pqpo/pragma";\n', "apps/desktop/src/preload/illegal.ts"),
    ).toContain("Desktop preload, renderer, and shared code");
    expect(
      await lintStdin('import "@pqpo/pragma";\n', "apps/desktop/src/renderer/illegal.ts"),
    ).toContain("Desktop preload, renderer, and shared code");
    expect(
      await lintStdin('import "@pragma/local-host";\n', "apps/desktop/src/main/legal.ts"),
    ).toBe("");
  }, 15_000);

  it("rejects surface-owned command and execution kernels", async () => {
    expect(
      await lintStdin(
        'import { ExpertSessionManager } from "@pragma/core";\nvoid ExpertSessionManager;\n',
        "apps/desktop/src/main/features/automations/illegal.ts",
      ),
    ).toContain("Desktop features must use Local Host Mission use cases");
    expect(
      await lintStdin(
        'import { createMissionControlApplication } from "@pragma/local-host";\nvoid createMissionControlApplication;\n',
        "apps/desktop/src/main/features/missions/illegal.ts",
      ),
    ).toContain("Mission command and execution kernels may only be composed by Local Host");
    expect(
      await lintStdin('import "@pragma/core";\n', "apps/cli/src/commands/illegal.ts"),
    ).toContain("CLI business operations must use the Local Host application boundary");
  }, 15_000);

  it("keeps Local Host and CLI manifests within their internal dependency partitions", async () => {
    const [localHostManifest, cliManifest] = (
      await Promise.all([
        readFile(new URL("../package.json", import.meta.url), "utf8"),
        readFile(new URL("../../../apps/cli/package.json", import.meta.url), "utf8"),
      ])
    ).map((content) => JSON.parse(content) as PackageManifest);

    expect(
      manifestBoundaryViolations(localHostManifest, localHostInternalDependencyAllowlist),
    ).toEqual([]);
    expect(manifestBoundaryViolations(cliManifest, cliInternalDependencyAllowlist)).toEqual([]);

    for (const manifest of [localHostManifest, cliManifest]) {
      expect(
        manifestDependencyNames(manifest).some(
          (name) => name === "electron" || name === "@pragma/desktop" || name.startsWith("apps/"),
        ),
      ).toBe(false);
    }
  });

  it("detects illegal internal dependencies and non-workspace versions in every manifest bucket", () => {
    expect(
      manifestBoundaryViolations(
        {
          dependencies: {
            "@pragma/local-host": "workspace:*",
            "@pragma/shared": "workspace:*",
            "@pragma/runtime-antigravity": "workspace:*",
            "@pragma/runtime-claude-code": "workspace:*",
            "@pragma/runtime-codex": "workspace:*",
            "@pragma/runtime-opencode": "workspace:*",
            "@pragma/runtime-pi": "workspace:*",
            "@pragma/runtime-qodercli": "workspace:*",
          },
          devDependencies: { "@pragma/tsconfig": "workspace:*" },
          peerDependencies: { "@pragma/core": "workspace:*" },
        },
        cliInternalDependencyAllowlist,
      ),
    ).toEqual(["peerDependencies must not include @pragma/core"]);
    expect(
      manifestBoundaryViolations(
        {
          dependencies: {
            "@pragma/local-host": "workspace:*",
            "@pragma/shared": "workspace:*",
            "@pragma/runtime-antigravity": "workspace:*",
            "@pragma/runtime-claude-code": "workspace:*",
            "@pragma/runtime-codex": "workspace:*",
            "@pragma/runtime-opencode": "workspace:*",
            "@pragma/runtime-pi": "workspace:*",
            "@pragma/runtime-qodercli": "workspace:*",
          },
          devDependencies: { "@pragma/tsconfig": "workspace:*" },
          optionalDependencies: { "@pragma/local-host": "1.0.0" },
        },
        cliInternalDependencyAllowlist,
      ),
    ).toEqual([
      "optionalDependencies must not include @pragma/local-host",
      "optionalDependencies.@pragma/local-host must use workspace:*",
    ]);
  });
});
