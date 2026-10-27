import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPackageWithOptions, uncacheAll } from "@electron/asar";
import { auditRuntimeResources } from "./audit-runtime-resources.mjs";
import { auditDesktopCli } from "./audit-desktop-cli.mjs";
import { auditPackagedResources, forbiddenClaudePayload } from "./audit-packaged-app.mjs";

test("reads the packed Desktop distribution identity before rejecting a different release", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-distribution-audit-"));
  try {
    const source = join(root, "source");
    const resources = join(root, "resources");
    await mkdir(join(source, "out", "main"), { recursive: true });
    await mkdir(resources);
    await writeFile(
      join(source, "out", "main", "distribution.json"),
      JSON.stringify({ distributionId: "different-release", distributionDigest: "mismatch" }),
    );
    await createPackageWithOptions(source, join(resources, "app.asar"), {});
    await assert.rejects(
      auditDesktopCli(resources, process.execPath),
      /Packaged Desktop main distribution does not match this release/,
    );
  } finally {
    uncacheAll();
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects all SDK platforms, old layouts and renamed native/script payloads", () => {
  for (const platform of [
    "darwin-arm64",
    "darwin-x64",
    "win32-x64",
    "win32-arm64",
    "linux-x64",
    "linux-arm64-musl",
  ])
    assert.ok(
      forbiddenClaudePayload(`node_modules/@anthropic-ai/claude-agent-sdk-${platform}/payload`, 1),
    );
  for (const name of ["cli.js", "vendor/bunfs/opaque", "bin/opaque"])
    assert.ok(forbiddenClaudePayload(`node_modules/@anthropic-ai/claude-agent-sdk/${name}`, 1));
  for (const magic of ["4d5a0000", "cffaedfe", "cafebabe", "7f454c46"])
    assert.ok(
      forbiddenClaudePayload(
        "node_modules/@anthropic-ai/claude-agent-sdk/renamed",
        1,
        Buffer.from(magic, "hex"),
      ),
    );
  assert.ok(
    forbiddenClaudePayload(
      "node_modules/@anthropic-ai/claude-agent-sdk/renamed.js",
      6 * 1024 * 1024,
    ),
  );
  for (const path of [
    "out/main/claude-acp-worker.js",
    "node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs",
    "node_modules/@anthropic-ai/claude-agent-sdk/bridge.mjs",
    "node_modules/@napi-rs/keyring/native.node",
  ])
    assert.equal(forbiddenClaudePayload(path, 1024), undefined);
});

test("audits real ASAR, unpacked files and extra resources; keeps worker and SDK JS", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-package-audit-"));
  try {
    const source = join(root, "source");
    const resources = join(root, "resources");
    await mkdir(join(source, "out/main"), { recursive: true });
    await mkdir(resources);
    await writeFile(join(source, "out/main/claude-acp-worker.js"), "console.log('worker')");
    await writeFile(join(source, "out/main/pragma-command-client.js"), "console.log('client')");
    const sdk = join(source, "node_modules/@anthropic-ai/claude-agent-sdk");
    await mkdir(sdk, { recursive: true });
    await writeFile(join(sdk, "sdk.mjs"), "export const query = () => {};");
    await createPackageWithOptions(source, join(resources, "app.asar"), {
      unpack: "**/{claude-acp-worker,pragma-command-client}.js",
    });
    const clean = await auditPackagedResources(resources);
    assert.deepEqual(clean.failures, []);
    assert.ok(
      clean.inventory.some(({ path }) => path === "app.asar/out/main/claude-acp-worker.js"),
    );
    assert.ok(clean.inventory.every(({ path }) => !path.includes("\\")));
    await writeFile(join(sdk, "cli.js"), "// forbidden legacy CLI");
    // This packed SDK payload must be inspected by content, not filename.
    await writeFile(join(sdk, "opaque"), Buffer.from("4d5a0000", "hex"));
    await createPackageWithOptions(source, join(resources, "app.asar"), {
      unpack: "**/{claude-acp-worker,pragma-command-client}.js",
    });
    await writeFile(join(resources, "claude.exe"), "MZ");
    const unpackedSdk = join(
      resources,
      "app.asar.unpacked/node_modules/@anthropic-ai/claude-agent-sdk",
    );
    await mkdir(unpackedSdk, { recursive: true });
    await writeFile(join(unpackedSdk, "renamed"), Buffer.from("7f454c46", "hex"));
    uncacheAll();
    const report = await auditPackagedResources(resources);
    assert.equal(report.failures.length, 4);
    assert.ok(
      report.failures.some(
        ({ path, reason }) =>
          path === "app.asar/node_modules/@anthropic-ai/claude-agent-sdk/opaque" &&
          reason === "Native executable inside SDK",
      ),
    );
    assert.ok(report.inventory.every(({ path }) => !path.includes("\\")));
    assert.ok(report.failures.some(({ path }) => path.startsWith("app.asar/")));
    assert.ok(report.failures.some(({ path }) => path.startsWith("app.asar.unpacked/")));
    assert.ok(report.failures.some(({ path }) => path === "claude.exe"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects a command client left inside ASAR", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-command-package-audit-"));
  try {
    const source = join(root, "source");
    const resources = join(root, "resources");
    await mkdir(join(source, "out/main"), { recursive: true });
    await mkdir(resources);
    await writeFile(join(source, "out/main/claude-acp-worker.js"), "console.log('worker')");
    await writeFile(join(source, "out/main/pragma-command-client.js"), "console.log('client')");
    await createPackageWithOptions(source, join(resources, "app.asar"), {
      unpack: "**/claude-acp-worker.js",
    });
    await assert.rejects(auditPackagedResources(resources), /Pragma command client.*outside ASAR/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("real ASAR rejects development files, maps, excluded copies and foreign native headers", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-package-policy-"));
  try {
    const source = join(root, "source"),
      resources = join(root, "resources");
    for (const dir of ["out/main", "src", "node_modules/react", "node_modules/native-sdk"])
      await mkdir(join(source, dir), { recursive: true });
    await mkdir(resources);
    for (const file of [
      "out/main/claude-acp-worker.js",
      "out/main/pragma-command-client.js",
      "src/index.ts",
      "node_modules/react/index.js",
      "node_modules/native-sdk/index.js.map",
    ])
      await writeFile(join(source, file), "// canary");
    const foreign = Buffer.alloc(32);
    foreign.writeUInt32BE(0xcffaedfe);
    foreign.writeUInt32LE(0x100000c, 4);
    await writeFile(join(source, "node_modules/native-sdk/native.node"), foreign);
    await createPackageWithOptions(source, join(resources, "app.asar"), {
      unpack: "**/{claude-acp-worker,pragma-command-client}.js",
    });
    const report = await auditPackagedResources(resources, {
      platform: "darwin",
      arch: "x64",
      excludedPackages: ["react"],
    });
    for (const reason of [
      "Application development files",
      "Production source map",
      "Bundled dependency copy",
    ])
      assert.ok(report.failures.some((failure) => failure.reason === reason));
    assert.ok(
      report.failures.some((failure) => failure.reason.includes("Native payload darwin/arm64")),
    );
    assert.equal(report.summary.categories["asar-metadata"] >= 0, true);
    assert.ok(report.inventory.find((file) => file.path.endsWith("native.node")).sha256);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("isolated smoke cannot borrow a dependency from the build directory", async () => {
  const { createRequire } = await import("node:module");
  const { readFile, access } = await import("node:fs/promises");
  const { withIsolatedPackagedApp } = await import("./audit-packaged-app.mjs");
  const root = await mkdtemp(join(tmpdir(), "pragma-smoke-resolver-"));
  const app = join(root, "dist/app");
  let copiedResources;
  try {
    await mkdir(join(root, "node_modules/pragma-repository-canary"), { recursive: true });
    await writeFile(
      join(root, "node_modules/pragma-repository-canary/index.js"),
      "module.exports=42;",
    );
    await mkdir(join(app, "resources"), { recursive: true });
    await writeFile(join(app, "resources/probe.mjs"), "// shipped canary");
    assert.ok(createRequire(join(app, "resources/probe.mjs")).resolve("pragma-repository-canary"));
    await assert.rejects(
      withIsolatedPackagedApp(
        app,
        join(app, "resources"),
        join(app, "electron"),
        async (resources) => {
          copiedResources = resources;
          assert.equal(await readFile(join(resources, "probe.mjs"), "utf8"), "// shipped canary");
          assert.throws(
            () => createRequire(join(resources, "probe.mjs")).resolve("pragma-repository-canary"),
            { code: "MODULE_NOT_FOUND" },
          );
          throw new Error("smoke-canary");
        },
      ),
      /smoke-canary/,
    );
    await assert.rejects(access(copiedResources), { code: "ENOENT" });
    await access(join(app, "resources/probe.mjs"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("afterPack saves smoke failures before rejecting the package", async () => {
  const { readFile } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const { default: afterPack } = await import("./audit-packaged-app.mjs");
  const root = await mkdtemp(join(tmpdir(), "pragma-smoke-report-"));
  try {
    const source = join(root, "source"),
      outDir = join(root, "reports"),
      appOutDir = join(root, "mac");
    const resources = join(appOutDir, "Fake.app/Contents/Resources");
    await mkdir(join(source, "out/main"), { recursive: true });
    await mkdir(resources, { recursive: true });
    await mkdir(outDir);
    for (const name of ["claude-acp-worker.js", "pragma-command-client.js"])
      await writeFile(join(source, "out/main", name), "// shipped worker");
    await createPackageWithOptions(source, join(resources, "app.asar"), {
      unpack: "**/{claude-acp-worker,pragma-command-client}.js",
    });
    await writeFile(
      join(outDir, "packaging-policy-darwin-1.json"),
      JSON.stringify({ platform: "darwin", arch: "x64", excludedPackages: [] }),
    );
    await assert.rejects(
      afterPack({
        appOutDir,
        outDir,
        electronPlatformName: "darwin",
        arch: 1,
        packager: {
          projectDir: fileURLToPath(new URL("../../../", import.meta.url)),
          appInfo: { productFilename: "Fake", version: "0.0.0" },
          config: {},
          platformSpecificBuildOptions: {},
          info: { framework: { version: "43.7.6" } },
        },
      }),
    );
    const report = JSON.parse(
      await readFile(join(outDir, "packaging-audit-darwin-1.json"), "utf8"),
    );
    assert.equal(report.validation.smoke, "failed");
    assert.equal(report.validation.cli, "pending");
    assert.ok(
      report.failures.some(({ path, reason }) => path === "packaged-smoke" && reason.length > 0),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime resource audit rejects broken shipped Pi entries before building its own probe", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-pi-entry-audit-"));
  const source = join(root, "source");
  const resources = join(root, "resources");
  try {
    await mkdir(join(source, "out/main/desktop-cli"), { recursive: true });
    await mkdir(resources);
    for (const brokenEntry of ["out/main/index.js", "out/main/desktop-cli/cli.js"]) {
      for (const entry of ["out/main/index.js", "out/main/desktop-cli/cli.js"])
        await writeFile(
          join(source, entry),
          entry === brokenEntry
            ? "const bundledPhoton = {};"
            : 'import("@silvia-odwyer/photon-node");',
        );
      // A healthy standalone probe cannot compensate for either broken production entry.
      await writeFile(join(source, "out/main/probe.js"), 'import("@silvia-odwyer/photon-node");');
      await createPackageWithOptions(source, join(resources, "app.asar"), {
        unpack: "**/desktop-cli/**/*",
      });
      uncacheAll();
      await assert.rejects(auditRuntimeResources(resources, process.execPath), (error) =>
        error.message.includes(`Production bundle ${brokenEntry} does not load external resource`),
      );
    }
  } finally {
    uncacheAll();
    await rm(root, { recursive: true, force: true });
  }
});
