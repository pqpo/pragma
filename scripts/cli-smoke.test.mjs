import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { loadDistribution } from "./distribution.mjs";

const execute = promisify(execFile);
test(
  "CLI platform smoke runs from a clean checkout without workspace dependencies",
  { skip: process.platform !== "linux" },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma clean smoke "));
    try {
      const script = join(root, "smoke-package.mjs");
      await copyFile(new URL("../apps/cli/scripts/smoke-package.mjs", import.meta.url), script);
      const tools = join(root, "tools");
      const artifacts = join(root, "artifacts");
      await mkdir(tools);
      await mkdir(artifacts);
      // Test harness only: emulate npm's negative OS check without network/install side effects.
      await writeFile(
        join(tools, "npm"),
        "#!/bin/sh\nprintf '%s\\n' 'npm ERR! EBADPLATFORM' >&2\nexit 1\n",
        { mode: 0o700 },
      );
      const { config, digest } = await loadDistribution({});
      const tarball = Buffer.from("negative-install fixture");
      const sha256 = createHash("sha256").update(tarball).digest("hex");
      const manifest = {
        distribution: config,
        package: config.cliPackageName,
        version: "1.0.0",
        tarball: "pragma-cli.tgz",
        sha256,
        buildIdentity: {
          version: "1.0.0",
          commit: "a".repeat(40),
          cliSha256: "b".repeat(64),
          distributionId: config.id,
          distributionDigest: digest,
        },
      };
      await writeFile(join(artifacts, "artifact-manifest.json"), JSON.stringify(manifest));
      await writeFile(join(artifacts, "pragma-cli.tgz"), tarball);
      await writeFile(join(artifacts, "SHA256SUMS.txt"), `${sha256}  pragma-cli.tgz\n`);
      const { stdout } = await execute(
        process.execPath,
        [script, "--mode", "linux", "--artifact-dir", artifacts],
        {
          cwd: root,
          env: {
            ...process.env,
            NODE_PATH: "",
            NODE_OPTIONS: "",
            PATH: tools + delimiter + process.env.PATH,
          },
          timeout: 30_000,
        },
      );
      assert.equal(JSON.parse(stdout).ok, true);
      const invalid = { ...config, homeEnvironmentVariable: "UNSAFE;HOME" };
      manifest.distribution = invalid;
      manifest.buildIdentity.distributionDigest = createHash("sha256")
        .update(JSON.stringify(invalid))
        .digest("hex");
      await writeFile(join(artifacts, "artifact-manifest.json"), JSON.stringify(manifest));
      await assert.rejects(
        execute(process.execPath, [script, "--mode", "linux", "--artifact-dir", artifacts], {
          cwd: root,
        }),
        /Invalid artifact distribution descriptor/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
