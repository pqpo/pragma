import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

test("npm verification retries transient absence, fails immutable mismatch and bounds registry waiting", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-npm-metadata-"));
  try {
    await mkdir(join(root, "release-artifact"));
    await writeFile(
      join(root, "release-artifact/pack.json"),
      JSON.stringify([{ integrity: "sha512-fixture", shasum: "a".repeat(40) }]),
    );
    const preload = join(root, "registry.mjs");
    await writeFile(
      preload,
      `import fs from 'node:fs';import {createRequire,syncBuiltinESMExports} from 'node:module';const require=createRequire(import.meta.url);const state=JSON.parse(fs.readFileSync(process.env.TEST_REGISTRY));require('node:timers/promises').setTimeout=async()=>{};syncBuiltinESMExports();let call=0;globalThis.fetch=async(url,options)=>{if(url!=='https://registry.npmjs.org/@pqpo%2fpragma'||!options.signal)throw Error('Unexpected registry request');const r=state.responses[call++]??{status:404};return {ok:r.status===200,status:r.status,json:async()=>r.body}};if(state.expire){let n=0;Object.defineProperty(globalThis,'performance',{value:{now:()=>n++*120000}})};const timeout=AbortSignal.timeout;AbortSignal.timeout=(ms)=>{if(ms>15000||ms<1)throw Error('Unbounded request');return timeout(ms)};`,
    );
    const version = "1.0.0";
    const metadata = {
      name: "@pqpo/pragma",
      version,
      engines: { node: ">=22" },
      os: ["darwin", "win32"],
      bin: { pragma: "./dist/pragma.js" },
      dist: { integrity: "sha512-fixture", shasum: "a".repeat(40) },
    };
    const document = { versions: { [version]: metadata }, "dist-tags": { next: version } };
    const state = join(root, "state.json");
    const output = join(root, "metadata.json");
    async function invoke(responses, expire = false) {
      await writeFile(state, JSON.stringify({ responses, expire }));
      return spawnSync(
        process.execPath,
        [fileURLToPath(new URL("./verify-npm-metadata.mjs", import.meta.url))],
        {
          cwd: root,
          encoding: "utf8",
          timeout: 5000,
          env: {
            ...process.env,
            NODE_OPTIONS: `--import=${preload}`,
            TEST_REGISTRY: state,
            RELEASE_VERSION: version,
            RELEASE_DIST_TAG: "next",
            METADATA_PATH: output,
          },
        },
      );
    }
    let result = await invoke([{ status: 404 }, { status: 503 }, { status: 200, body: document }]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(output, "utf8")).version, version);
    result = await invoke([
      {
        status: 200,
        body: {
          ...document,
          versions: { [version]: { ...metadata, dist: { ...metadata.dist, integrity: "wrong" } } },
        },
      },
    ]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Immutable npm metadata mismatch: dist.integrity/);
    result = await invoke([{ status: 403 }]);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /HTTP 403/);
    result = await invoke([{ status: 404 }], true);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /within 5 minutes/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
