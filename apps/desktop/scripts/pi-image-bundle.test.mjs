import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import sharp from "sharp";
import { assertExternalResourceImport } from "../../cli/scripts/package-audit-lib.mjs";
import { RUNTIME_RESOURCE_EXTERNALS } from "../../cli/scripts/build-bundles.mjs";

const execute = promisify(execFile);
const probe = fileURLToPath(
  new URL("../../../packages/runtime/pi/test/support/image-probe.mjs", import.meta.url),
);

test("bundled Pi preserves images in native read and prompt without workspace dependencies", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pragma-pi-images-"));
  try {
    const require = createRequire(import.meta.url);
    const photonDirectory = dirname(require.resolve("@silvia-odwyer/photon-node"));
    const destination = join(directory, "node_modules/@silvia-odwyer/photon-node");
    await mkdir(dirname(destination), { recursive: true });
    await cp(photonDirectory, destination, { recursive: true });
    const fixtures = [];
    for (const [format, width, height] of [
      ["png", 8, 8],
      ["jpeg", 600, 400],
      ["png", 2180, 684],
      ["webp", 2300, 100],
    ]) {
      const path = join(directory, `${format}-${width}.${format}`);
      await sharp({ create: { width, height, channels: 3, background: "#d23b4f" } })
        .toFormat(format)
        .toFile(path);
      fixtures.push({ path, mimeType: `image/${format}` });
    }
    assert.ok((await readFile(fixtures[0].path)).byteLength < 17000);
    const options = {
      stdin: {
        contents: `import {probePiImages} from ${JSON.stringify(probe)}; await probePiImages(process.argv[2], JSON.parse(process.argv[3])); console.log('pi-images-ok');`,
        resolveDir: dirname(probe),
      },
      bundle: true,
      minify: true,
      keepNames: true,
      platform: "node",
      target: "node22",
      format: "esm",
      logLevel: "silent",
      banner: {
        js: 'import {createRequire as __pragmaCreateRequire} from "node:module";const require=__pragmaCreateRequire(import.meta.url);',
      },
    };
    // The old bundle silently dropped even tiny images when Photon was inlined.
    for (const [name, external, succeeds] of [
      ["old", [], false],
      ["fixed", RUNTIME_RESOURCE_EXTERNALS, true],
    ]) {
      const outfile = join(directory, `${name}.mjs`);
      await build({ ...options, outfile, external });
      const audit = () =>
        assertExternalResourceImport(`${name}.mjs`, "@silvia-odwyer/photon-node", async (path) =>
          readFile(join(directory, path), "utf8"),
        );
      if (succeeds) await audit();
      else await assert.rejects(audit(), /does not load external resource/);
      const invocation = () =>
        execute(process.execPath, [outfile, directory, JSON.stringify(fixtures)], {
          cwd: directory,
          env: {
            ...process.env,
            NODE_PATH: "",
            NODE_OPTIONS: "",
            PI_CODING_AGENT_DIR: join(directory, "agent"),
          },
          timeout: 30000,
          maxBuffer: 1024 * 1024,
        });
      if (succeeds) assert.equal((await invocation()).stdout.trim(), "pi-images-ok");
      else await assert.rejects(invocation(), /Pi read dropped/);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
