import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { createPackageWithOptions, uncacheAll } from "@electron/asar";
import { auditPackagedResources, forbiddenClaudePayload } from "./audit-packaged-app.mjs";

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
