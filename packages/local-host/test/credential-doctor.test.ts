import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { integrationErrorExitCode } from "@pragma/shared/integration";
import { afterEach, describe, expect, it } from "vitest";

import { inspectCredentialMigration, type OsKeychain } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

const readyKeychain: OsKeychain = {
  inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
  get: async () => null,
  set: async () => undefined,
  delete: async () => undefined,
};

describe("credential doctor schema versions", () => {
  it.each([
    ["model-provider", 6],
    ["capability", 3],
    ["plugin", 3],
  ] as const)(
    "reports future %s files as degraded storage incompatibility",
    async (module, version) => {
      const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-"));
      roots.push(root);
      const file = join(root, `${module}.json`);
      await mkdir(root, { recursive: true });
      await writeFile(file, JSON.stringify({ schemaVersion: version }));
      const findings = await inspectCredentialMigration({
        secretStore: {
          inspect: async () => ({ status: "ready", backend: "macos-keychain" }),
          get: async () => {
            throw new Error("not used");
          },
          put: async () => {
            throw new Error("not used");
          },
          delete: async () => {
            throw new Error("not used");
          },
          listMetadata: async () => [],
        },
        files: { "model-provider": file, capability: file, plugin: file },
      });
      const finding = findings.find((entry) => entry.module === module)!;
      expect(finding).toMatchObject({ status: "degraded", code: "STORAGE_VERSION_UNSUPPORTED" });
      expect(integrationErrorExitCode(finding.code!)).toBe(7);
    },
  );

  it("reports only the target version as ready and older versions as migration-required", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-credential-doctor-"));
    roots.push(root);
    const paths = {
      "model-provider": join(root, "model.json"),
      capability: join(root, "capability.json"),
      plugin: join(root, "plugin.json"),
    } as const;
    await Promise.all([
      writeFile(paths["model-provider"], JSON.stringify({ schemaVersion: 5 })),
      writeFile(paths.capability, JSON.stringify({ schemaVersion: 1 })),
      writeFile(paths.plugin, JSON.stringify({ schemaVersion: 2 })),
    ]);
    const findings = await inspectCredentialMigration({
      secretStore: {
        inspect: readyKeychain.inspect,
        get: readyKeychain.get,
        put: readyKeychain.put,
        delete: readyKeychain.delete,
        listMetadata: async () => [],
      },
      files: paths,
    });
    expect(findings).toEqual([
      { module: "model-provider", status: "ready" },
      { module: "capability", status: "migration_required", code: "SECRET_MIGRATION_REQUIRED" },
      { module: "plugin", status: "ready" },
    ]);
  });
});
