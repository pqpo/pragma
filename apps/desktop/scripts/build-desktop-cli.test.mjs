import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveDesktopSourceCommit } from "./build-desktop-cli.mjs";

test("development accepts source archives while builds require Git provenance", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-source-archive-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  assert.equal(resolveDesktopSourceCommit(directory, { development: true }), null);
  assert.throws(() => resolveDesktopSourceCommit(directory), /require a Git checkout/);
});

test("an empty Git repository is usable only for development", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-empty-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  execFileSync("git", ["init", "--quiet", directory]);
  assert.equal(resolveDesktopSourceCommit(directory, { development: true }), null);
  assert.throws(() => resolveDesktopSourceCommit(directory), /require a Git checkout/);
});

test("development and builds retain the real source commit in a Git checkout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-source-checkout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = (args) => execFileSync("git", args, { cwd: directory, encoding: "utf8" }).trim();
  git(["init", "--quiet"]);
  git([
    "-c",
    "user.name=Pragma Test",
    "-c",
    "user.email=test@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "fixture",
  ]);
  const commit = git(["rev-parse", "HEAD"]);
  assert.match(commit, /^[a-f0-9]{40,64}$/u);
  assert.equal(resolveDesktopSourceCommit(directory), commit);
  assert.equal(resolveDesktopSourceCommit(directory, { development: true }), commit);
});

test("one supplied profile reaches every CLI bundle after the external config disappears", async (t) => {
  const { cp, mkdir, readFile, symlink, writeFile } = await import("node:fs/promises");
  const { fileURLToPath, pathToFileURL } = await import("node:url");
  const { loadDistribution } = await import("../../../scripts/distribution.mjs");
  const root = await mkdtemp(join(tmpdir(), "pragma snapshot build "));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const path of ["scripts", "apps/cli/scripts", "apps/desktop/scripts"])
    await mkdir(join(root, path), { recursive: true });
  await writeFile(
    join(root, "scripts/distribution.mjs"),
    `export * from ${JSON.stringify(new URL("../../../scripts/distribution.mjs", import.meta.url).href)};`,
  );
  await cp(
    new URL("../../cli/scripts/build-bundles.mjs", import.meta.url),
    join(root, "apps/cli/scripts/build-bundles.mjs"),
  );
  await cp(
    new URL("./build-desktop-cli.mjs", import.meta.url),
    join(root, "apps/desktop/scripts/build-desktop-cli.mjs"),
  );
  await symlink(
    fileURLToPath(new URL("../../cli/node_modules", import.meta.url)),
    join(root, "apps/cli/node_modules"),
    "junction",
  );
  for (const app of ["cli", "desktop"])
    await writeFile(join(root, `apps/${app}/package.json`), JSON.stringify({ version: "0.0.1" }));
  const { CLI_WORKERS } = await import("../../cli/scripts/build-bundles.mjs");
  for (const path of ["apps/cli/src/index.ts", ...Object.values(CLI_WORKERS)]) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(
      join(root, path),
      "process.stdout.write(JSON.stringify({config:__PRAGMA_BUILD_DISTRIBUTION__,version:__PRAGMA_CLI_VERSION__}));",
    );
  }
  await writeFile(join(root, "apps/cli/src/pragma.ts"), "#!/usr/bin/env node\nimport './cli.js';");
  const profile = await loadDistribution({
    PRAGMA_DISTRIBUTION_CONFIG: fileURLToPath(
      new URL("../../../examples/distribution.acme.json", import.meta.url),
    ),
  });
  const buildModule = await import(
    pathToFileURL(join(root, "apps/desktop/scripts/build-desktop-cli.mjs")).href
  );
  const previous = process.env.PRAGMA_DISTRIBUTION_CONFIG;
  process.env.PRAGMA_DISTRIBUTION_CONFIG = join(root, "removed-profile.json");
  try {
    const output = join(root, "out/main");
    await buildModule.buildDesktopCli(output, { development: true, distribution: profile });
    const metadata = JSON.parse(
      await readFile(join(output, "desktop-cli/distribution.json"), "utf8"),
    );
    assert.equal(metadata.distributionDigest, profile.digest);
    assert.equal(metadata.cliVersion, profile.config.cliVersion);
    for (const name of ["cli", ...Object.keys(CLI_WORKERS)]) {
      const actual = JSON.parse(
        execFileSync(process.execPath, [join(output, `desktop-cli/${name}.js`)], {
          encoding: "utf8",
        }),
      );
      assert.equal(actual.config.id, profile.config.id);
      assert.equal(actual.version, profile.config.cliVersion);
    }
  } finally {
    if (previous === undefined) delete process.env.PRAGMA_DISTRIBUTION_CONFIG;
    else process.env.PRAGMA_DISTRIBUTION_CONFIG = previous;
  }
});
