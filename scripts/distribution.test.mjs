import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import { distributionBanner, loadDistribution } from "./distribution.mjs";

const example = JSON.parse(
  await readFile(new URL("../examples/distribution.acme.json", import.meta.url), "utf8"),
);
test("default identity retains the historical Windows installer and credentials", async () => {
  const { config, windowsUninstallGuid } = await loadDistribution({});
  assert.equal(config.applicationName, "Pragma Desktop");
  assert.equal(config.credentialNamespace, "default");
  assert.equal(windowsUninstallGuid, "a5a058dd-b5ec-5fb0-bd32-59ea8f559e83");
});
test("external configuration is validated and its content changes the digest at the same path", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-distribution-"));
  try {
    const path = join(directory, "profile.json");
    const env = { PRAGMA_DISTRIBUTION_CONFIG: path };
    await writeFile(path, JSON.stringify(example));
    const first = await loadDistribution(env);
    assert.notEqual(first.windowsUninstallGuid, (await loadDistribution({})).windowsUninstallGuid);
    await writeFile(path, JSON.stringify({ ...example, cliVersion: "1.0.1" }));
    assert.notEqual((await loadDistribution(env)).digest, first.digest);
    for (const patch of [
      { cliCommand: "pragma" },
      { homeEnvironmentVariable: "PRAGMA_HOME" },
      { credentialNamespace: "default" },
      { homeDirectory: "../escape" },
      { homeDirectory: "aux.txt" },
      { cliCommand: "con" },
      { productName: "Trailing " },
      { homeDirectory: example.developmentHomeDirectory },
      { cliCommand: "bad;command" },
      { desktopVersion: "not-semver" },
      { privateKey: "forbidden" },
    ]) {
      await writeFile(path, JSON.stringify({ ...example, ...patch }));
      await assert.rejects(loadDistribution(env));
    }
    await writeFile(path, "{invalid");
    await assert.rejects(loadDistribution(env));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test("entry banner fixes one immutable identity and rejects mixed bundles", async () => {
  const context = {};
  const banner = distributionBanner(example);
  runInNewContext(banner, context);
  runInNewContext(banner, context);
  assert.equal(context.__PRAGMA_DISTRIBUTION__.id, example.id);
  assert.equal(Object.getOwnPropertyDescriptor(context, "__PRAGMA_DISTRIBUTION__").writable, false);
  assert.throws(
    () => runInNewContext(distributionBanner({ ...example, id: "other" }), context),
    /Conflicting/,
  );
});

test("packaging rejects a main/CLI mixed identity even when the CLI matches the requested profile", async () => {
  const { assertDesktopDistribution } = await import("./distribution.mjs");
  const directory = await mkdtemp(join(tmpdir(), "pragma mixed identity "));
  try {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(directory, "desktop-cli"));
    const profile = await loadDistribution({});
    const matching = { distributionId: profile.config.id, distributionDigest: profile.digest };
    await writeFile(
      join(directory, "distribution.json"),
      JSON.stringify({ ...matching, distributionDigest: "old-main-build" }),
    );
    await writeFile(join(directory, "desktop-cli/distribution.json"), JSON.stringify(matching));
    await assert.rejects(
      assertDesktopDistribution(directory, profile),
      /mismatch in distribution.json/,
    );
    await writeFile(join(directory, "distribution.json"), JSON.stringify(matching));
    await assertDesktopDistribution(directory, profile);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
