import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

test("prepared artifact rejects changed bytes, missing files, same-commit source edits and future manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-artifact-"));
  try {
    await mkdir(join(root, "scripts"));
    await cp(
      new URL("./build-artifact.mjs", import.meta.url),
      join(root, "scripts/build-artifact.mjs"),
    );
    for (const name of [
      "workspace-build-artifact.mjs",
      "archive-workspace-build.mjs",
      "distribution.mjs",
    ])
      await cp(new URL(`./${name}`, import.meta.url), join(root, `scripts/${name}`));
    await mkdir(join(root, "packages/shared/src"), { recursive: true });
    await cp(
      new URL("../packages/shared/src/distribution.ts", import.meta.url),
      join(root, "packages/shared/src/distribution.ts"),
    );
    await symlink(
      fileURLToPath(new URL("../node_modules", import.meta.url)),
      join(root, "node_modules"),
      "junction",
    );
    await symlink(
      fileURLToPath(new URL("../packages/shared/node_modules", import.meta.url)),
      join(root, "packages/shared/node_modules"),
      "junction",
    );
    await writeFile(
      join(root, ".gitignore"),
      "node_modules/\ndist/\n.release/\nout/\n.plugin-bundles/\n.packaging/\n.test-results/\n",
    );
    for (const app of ["cli", "desktop"]) {
      await mkdir(join(root, `apps/${app}`), { recursive: true });
      await writeFile(join(root, `apps/${app}/package.json`), JSON.stringify({ version: "1.0.0" }));
    }
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["add", "."], { cwd: root });
    execFileSync(
      "git",
      [
        "-c",
        "user.name=Artifact Test",
        "-c",
        "user.email=artifact@example.invalid",
        "commit",
        "--quiet",
        "-m",
        "fixture",
      ],
      { cwd: root },
    );
    await mkdir(join(root, "apps/cli/dist"));
    await mkdir(join(root, "apps/cli/.release/package"), { recursive: true });
    await writeFile(join(root, "apps/cli/dist/cli.js"), "original");
    const { loadDistribution } = await import(
      pathToFileURL(join(root, "scripts/distribution.mjs")).href
    );
    const profile = await loadDistribution({});
    const identity = { distributionId: profile.config.id, distributionDigest: profile.digest };
    await writeFile(
      join(root, "apps/cli/.release/package/package.json"),
      JSON.stringify({ pragmaDistribution: { id: profile.config.id, digest: profile.digest } }),
    );
    for (const name of [
      "cli",
      "code-service-worker",
      "canonical-event-feed-worker",
      "vector-worker",
      "claude-acp-worker",
      "sqlite-execution-worker",
    ])
      await writeFile(join(root, `apps/cli/.release/${name}.metafile.json`), "{}");
    const { recordArtifact, verifyArtifact } = await import(
      pathToFileURL(join(root, "scripts/build-artifact.mjs")).href
    );
    await recordArtifact("cli");
    await verifyArtifact("cli");
    const configPath = join(root, "apps/cli/.release/profile.json");
    const { config } = await loadDistribution({});
    await writeFile(configPath, JSON.stringify(config));
    const previousConfig = process.env.PRAGMA_DISTRIBUTION_CONFIG;
    try {
      process.env.PRAGMA_DISTRIBUTION_CONFIG = configPath;
      await verifyArtifact("cli");
      await writeFile(configPath, JSON.stringify({ ...config, cliVersion: "9.0.0" }));
      await assert.rejects(verifyArtifact("cli"), /Stale/);
      await assert.rejects(recordArtifact("cli"), /distribution mismatch/);
    } finally {
      if (previousConfig === undefined) delete process.env.PRAGMA_DISTRIBUTION_CONFIG;
      else process.env.PRAGMA_DISTRIBUTION_CONFIG = previousConfig;
    }
    // The archive covers compiled dependencies beyond the CLI/Desktop manifests.
    await mkdir(join(root, ".test-results"));
    await mkdir(join(root, "packages/core/dist"), { recursive: true });
    const dependency = join(root, "packages/core/dist/index.js");
    await writeFile(dependency, "compiled dependency");
    const archive = join(root, ".test-results/workspace-build.tar.gz");
    execFileSync("tar", ["-czf", archive, "packages/core/dist"], { cwd: root });
    const archiveModule = await import(
      pathToFileURL(join(root, "scripts/workspace-build-artifact.mjs")).href
    );
    await archiveModule.recordWorkspaceArchive();
    await archiveModule.verifyWorkspaceArchive();
    const restore = () =>
      execFileSync(process.execPath, ["scripts/archive-workspace-build.mjs", "restore"], {
        cwd: root,
        stdio: "pipe",
      });
    await rm(dependency);
    restore();
    assert.equal(await readFile(dependency, "utf8"), "compiled dependency");
    const bytes = await readFile(archive);
    await writeFile(archive, Buffer.concat([bytes, Buffer.from("corrupt dependency")]));
    await assert.rejects(archiveModule.verifyWorkspaceArchive(), /digest mismatch/);
    await writeFile(dependency, "must not overwrite before verification");
    assert.throws(restore, /digest mismatch/);
    assert.equal(await readFile(dependency, "utf8"), "must not overwrite before verification");
    await writeFile(archive, bytes);
    await writeFile(join(root, "source.ts"), "dirty source");
    await assert.rejects(archiveModule.verifyWorkspaceArchive(), /Stale workspace/);
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    const archiveManifestPath = join(root, ".test-results/workspace-build.json");
    const archiveManifest = JSON.parse(await readFile(archiveManifestPath, "utf8"));
    await writeFile(archiveManifestPath, JSON.stringify({ ...archiveManifest, schemaVersion: 2 }));
    await assert.rejects(archiveModule.verifyWorkspaceArchive(), /Stale workspace/);
    await writeFile(archiveManifestPath, JSON.stringify(archiveManifest));
    await rm(archive);
    await assert.rejects(archiveModule.verifyWorkspaceArchive(), /ENOENT/);
    await mkdir(join(root, "apps/desktop/out/main/desktop-cli"), { recursive: true });
    await writeFile(
      join(root, "apps/desktop/out/main/distribution.json"),
      JSON.stringify(identity),
    );
    await writeFile(
      join(root, "apps/desktop/out/main/desktop-cli/distribution.json"),
      JSON.stringify(identity),
    );
    await mkdir(join(root, "apps/desktop/.packaging"), { recursive: true });
    await mkdir(join(root, "apps/desktop/.plugin-bundles/plugins"), { recursive: true });
    await writeFile(join(root, "apps/desktop/out/main.js"), "desktop");
    await writeFile(join(root, "apps/desktop/.packaging/cli-metafiles.json"), "{}");
    await recordArtifact("desktop");
    await rm(join(root, "apps/desktop/.plugin-bundles"), { recursive: true });
    await verifyArtifact("desktop");
    await writeFile(join(root, "apps/desktop/.plugin-bundles/plugins/plugin.json"), "{}");
    await recordArtifact("desktop");
    await rm(join(root, "apps/desktop/.plugin-bundles"), { recursive: true });
    await assert.rejects(verifyArtifact("desktop"), /ENOENT/);
    const bundle = join(root, "apps/cli/dist/cli.js");
    await writeFile(bundle, "corrupted");
    await assert.rejects(verifyArtifact("cli"), /digest mismatch/);
    await rm(bundle);
    await assert.rejects(verifyArtifact("cli"), /Incomplete/);
    await writeFile(bundle, "original");
    await writeFile(join(root, "source.ts"), "export const value = 2;\n");
    await assert.rejects(verifyArtifact("cli"), /Stale/);
    await writeFile(join(root, "source.ts"), "export const value = 1;\n");
    const manifestPath = join(root, "apps/cli/.release/prepared.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.schemaVersion = 2;
    await writeFile(manifestPath, JSON.stringify(manifest));
    await assert.rejects(verifyArtifact("cli"), /Stale/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
