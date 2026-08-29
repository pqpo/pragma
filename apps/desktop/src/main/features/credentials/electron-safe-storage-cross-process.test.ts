import { createHash } from "node:crypto";
import { build } from "esbuild";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const desktopRoot = resolve(import.meta.dirname, "../../../..");
const repositoryRoot = resolve(desktopRoot, "../..");
const electron = join(desktopRoot, "node_modules", ".bin", "electron");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe.runIf(process.platform === "darwin")("real Electron safeStorage migration", () => {
  it("migrates real Electron ciphertext and lets an independent CLI host read all families", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-e07-electron-"));
    roots.push(root);
    const bundleRoot = await mkdtemp(join(desktopRoot, ".m10-e07-bundle-"));
    roots.push(bundleRoot);
    const bundle = join(bundleRoot, "electron-safe-storage-migrator.mjs");
    const readerBundle = join(bundleRoot, "electron-safe-storage-cli-reader.mjs");
    let bundleReady = false;

    try {
      await build({
        entryPoints: [
          join(
            desktopRoot,
            "src/main/features/credentials/electron-safe-storage-migrator.fixture.ts",
          ),
        ],
        absWorkingDir: repositoryRoot,
        bundle: true,
        external: ["electron", "@napi-rs/keyring", "@pragma/*"],
        format: "esm",
        outfile: bundle,
        platform: "node",
        target: "node22",
      });
      bundleReady = true;
      await build({
        entryPoints: [
          join(
            desktopRoot,
            "src/main/features/credentials/electron-safe-storage-cli-reader.fixture.ts",
          ),
        ],
        absWorkingDir: repositoryRoot,
        bundle: true,
        external: ["@napi-rs/keyring", "@pragma/*"],
        format: "esm",
        outfile: readerBundle,
        platform: "node",
        target: "node22",
      });

      const writer = await invokeElectron(bundle, "write", root);
      expect(writer.exitCode).toBe(0);
      expect(writer.stderr).toBe("");
      expect(JSON.parse(writer.stdout)).toMatchObject({
        action: "write",
        safeStorage: "available",
      });

      const legacy = JSON.stringify({
        provider: "e07-provider-secret",
        capability: "e07-capability-secret",
        plugin: "e07-plugin-secret",
      });
      expect(
        JSON.stringify(await readFile(join(root, "data", "model-providers.json"), "utf8")),
      ).not.toContain(legacy);

      const migrator = await invokeElectron(bundle, "migrate", root);
      expect(migrator.exitCode).toBe(0);
      expect(migrator.stderr).toBe("");
      expect(JSON.parse(migrator.stdout)).toMatchObject({
        action: "migrate",
        safeStorage: "available",
      });

      const reader = await invokeCliReader(readerBundle, root);
      expect(reader.exitCode).toBe(0);
      expect(reader.stderr).toBe("");
      expect(JSON.parse(reader.stdout)).toEqual({
        digests: {
          provider: digest("e07-provider-secret"),
          capability: digest("e07-capability-secret"),
          plugin: digest("e07-plugin-secret"),
        },
      });

      const currentProviders = JSON.parse(
        await readFile(join(root, "data", "model-providers.json"), "utf8"),
      ) as { schemaVersion: number };
      const currentCapabilities = JSON.parse(
        await readFile(join(root, "data", "credentials", "capability-credentials.json"), "utf8"),
      ) as { schemaVersion: number };
      const currentPlugins = JSON.parse(
        await readFile(join(root, "data", "credentials", "plugin-credentials.json"), "utf8"),
      ) as { schemaVersion: number };
      expect({
        providers: currentProviders.schemaVersion,
        capabilities: currentCapabilities.schemaVersion,
        plugins: currentPlugins.schemaVersion,
      }).toEqual({ providers: 5, capabilities: 2, plugins: 2 });
      for (const path of [
        join(root, "data", "model-providers.json"),
        join(root, "data", "credentials", "capability-credentials.json"),
        join(root, "data", "credentials", "plugin-credentials.json"),
      ]) {
        expect(await readFile(path, "utf8")).not.toMatch(
          /e07-(provider|capability|plugin)-secret/u,
        );
      }
    } finally {
      if (bundleReady) {
        const cleanup = await invokeElectron(bundle, "cleanup", root);
        expect(cleanup.exitCode).toBe(0);
        expect(cleanup.stderr).toBe("");
      }
    }
  }, 120_000);
});

async function invokeElectron(
  bundle: string,
  action: "write" | "migrate" | "cleanup",
  root: string,
) {
  return await invoke(
    electron,
    [
      "--no-sandbox",
      join(desktopRoot, "src/main/features/credentials/electron-safe-storage-host.fixture.mjs"),
      bundle,
      action,
      root,
    ],
    {
      cwd: repositoryRoot,
    },
  );
}

async function invokeCliReader(readerBundle: string, root: string) {
  return await invoke(electron, ["--run-as-node", readerBundle, root], { cwd: repositoryRoot });
}

function invoke(
  command: string,
  arguments_: readonly string[],
  options: { readonly cwd: string },
): Promise<ProcessResult> {
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, arguments_, {
      cwd: options.cwd,
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolveResult({ exitCode, signal, stdout, stderr }));
  });
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
