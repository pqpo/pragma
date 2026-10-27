import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { loadDistribution } from "../../../scripts/distribution.mjs";
import { assertDistributionBuilderArguments } from "./package-desktop.mjs";
import { createDistributionBuilderConfig } from "./distribution-builder.mjs";

const require = createRequire(import.meta.url);
const builderRequire = createRequire(require.resolve("electron-builder"));
const { getConfig, validateConfiguration } = builderRequire(
  "app-builder-lib/out/util/config/config.js",
);

test("both distribution configs pass the real builder schema and retain packaging policy without duplicate resources", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-builder-profile-"));
  try {
    const profiles = [
      await loadDistribution({}),
      await loadDistribution({
        PRAGMA_DISTRIBUTION_CONFIG: fileURLToPath(
          new URL("../../../examples/distribution.acme.json", import.meta.url),
        ),
      }),
    ];
    for (const profile of profiles) {
      const path = join(directory, `${profile.config.id}.json`);
      await writeFile(path, JSON.stringify(createDistributionBuilderConfig(profile)));
      const config = await getConfig(fileURLToPath(new URL("../", import.meta.url)), path, null);
      await validateConfiguration(config, { add() {} });
      assert.equal(config.appId, profile.config.applicationId);
      assert.equal(config.executableName, profile.config.executableName);
      assert.equal(config.nsis.guid, profile.windowsUninstallGuid);
      assert.equal(config.nsis.perMachine, true);
      assert.equal(config.mac.identity, null);
      assert.deepEqual(config.mac.target, ["dmg", "zip"]);
      assert.equal(config.extraResources.length, 6);
      assert.equal(
        config.extraResources.filter((resource) => resource.to === "distribution.json").length,
        1,
      );
      assert.equal(config.extraMetadata.version, profile.config.desktopVersion);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("packaging rejects identity overrides before invoking a build or clearing output", () => {
  for (const argument of [
    "--config",
    "--config=other.yml",
    "--config.appId=com.other.app",
    "-c",
    "-c.appId=com.other.app",
  ]) {
    assert.throws(
      () => assertDistributionBuilderArguments(["--mac", argument]),
      /PRAGMA_DISTRIBUTION_CONFIG/,
    );
  }
  assert.doesNotThrow(() =>
    assertDistributionBuilderArguments(["--mac", "--arm64", "--publish", "never"]),
  );
});
