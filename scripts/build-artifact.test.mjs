import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, cp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

test("prepared artifact rejects changed bytes, missing files, same-commit source edits and future manifests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-artifact-"));
  try {
    await mkdir(join(root, "scripts"));
    await cp(
      new URL("./build-artifact.mjs", import.meta.url),
      join(root, "scripts/build-artifact.mjs"),
    );
    await writeFile(
      join(root, ".gitignore"),
      "dist/\n.release/\nout/\n.plugin-bundles/\n.packaging/\n",
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
    await writeFile(join(root, "apps/cli/.release/package/package.json"), "{}");
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
    await mkdir(join(root, "apps/desktop/out"), { recursive: true });
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
