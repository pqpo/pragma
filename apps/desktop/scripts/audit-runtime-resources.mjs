import { build } from "esbuild";
import { extractFile, listPackage, statFile } from "@electron/asar";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execute = promisify(execFile);
const samples = [
  "",
  "Hello, world!",
  "Pragma 中文测试 🧪",
  "function main(input) { return input; }",
];

/** Runs against the app's resolver and shipped tokenizer chunk, never workspace node_modules. */
export async function auditRuntimeResources(resources, executable) {
  const archive = join(resources, "app.asar");
  const tokenizerEntry = listPackage(archive)
    .map((path) => path.replaceAll("\\", "/").replace(/^\//, ""))
    .find((path) => /^out\/main\/chunks\/o200k_base-[^/]+\.js$/.test(path));
  if (!tokenizerEntry) throw new Error("Shipped lazy tokenizer chunk is missing.");
  const tokenizerArchivePath = join(...tokenizerEntry.split("/"));
  const tokenizerSource = extractFile(archive, tokenizerArchivePath).toString("utf8");
  if (!tokenizerSource.includes("countTokens"))
    throw new Error("Tokenizer chunk lost its countTokens export.");
  const home = await mkdtemp(join(tmpdir(), "pragma-packaged-runtime-"));
  const probe = join(`${archive}.unpacked`, "out/main/desktop-cli/packaging-runtime-probe.mjs");
  try {
    const fixture = JSON.parse(
      await readFile(
        new URL(
          "../../../packages/core/src/plugins/fixtures/context-plugin/plugin.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    fixture.id = "packaging.smoke";
    fixture.runtime.entry = "./plugin.mjs";
    await mkdir(join(home, "plugin"));
    await writeFile(
      join(home, "plugin/package.json"),
      JSON.stringify({ type: "module", name: "pragma-packaging-smoke", version: "0.0.0" }),
    );
    await writeFile(join(home, "plugin/plugin.json"), JSON.stringify(fixture));
    await build({
      stdin: {
        contents: `import {definePluginEntry,readExpertAgentPluginManifest} from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/dist/plugins/expert-agent-plugin.js", import.meta.url)))}; export default definePluginEntry({manifest:readExpertAgentPluginManifest(new URL('./plugin.json',import.meta.url)),setup:()=>({})});`,
        resolveDir: home,
      },
      outfile: join(home, "plugin/plugin.mjs"),
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      minify: true,
      keepNames: true,
      logLevel: "silent",
    });
    // The same lazy counter and plugin loader are compiled with the production settings.
    // Importing the shipped chunk additionally verifies its real ASAR location and export.
    const source = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    import { pathToFileURL } from 'node:url';
    import { Worker } from 'node:worker_threads';
    import { readdir, access } from 'node:fs/promises';
    import { join } from 'node:path';
    import { createRuntimeTokenCounter } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/dist/runtime/token-counter.js", import.meta.url)))};
    import { loadExpertAgentPlugins } from ${JSON.stringify(fileURLToPath(new URL("../../../packages/core/dist/plugins/plugin-loader.js", import.meta.url)))};
    const resources=process.argv[2], home=process.env.PRAGMA_HOME;
    const archive=join(resources,'app.asar');
    const require=createRequire(join(archive,'out/main/index.js'));
    const sharp=require('sharp');
    const image=await sharp({create:{width:8,height:8,channels:4,background:'#f00'}}).png().toBuffer();
    assert.equal((await sharp(image).metadata()).width,8);
    assert.equal((await sharp(image).resize(4,4).jpeg().toBuffer({resolveWithObject:true})).info.width,4);
    assert.equal(typeof require('@napi-rs/keyring').Entry,'function');
    const shipped=await import(pathToFileURL(join(archive,${JSON.stringify(tokenizerEntry)})).href);
    const counter=createRuntimeTokenCounter();
    assert.equal(await counter.load(),true);
    for(const sample of ${JSON.stringify(samples)}) {
      const counted=counter.countText(sample);
      assert.equal(counted.source,'tokenizer');
      assert.equal(counted.tokens,shipped.countTokens(sample));
    }
    counter.dispose();
    const loaded=await loadExpertAgentPlugins({agentId:'packaging-smoke',pragmaHome:join(home,'state'),sources:[join(home,'plugin')]});
    assert.equal(loaded.issues.length,0);assert.equal(loaded.pluginEntries.length,1);
    // SDK transport resources remain installed; authenticated execution is a separate native smoke.
    await access(join(archive,'node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/qoder-worker-runtime.obf.mjs'));
    const chunks=await readdir(join(archive,'out/main/chunks'));
    assert.ok(chunks.some(name=>name.startsWith('jiti-loader-')));
    async function quickjs(source, expectedCode) {
      const worker=new Worker(pathToFileURL(join(archive,'out/main/code-service-worker.js')));
      try {
        const result=await new Promise((resolve,reject)=>{
          const timer=setTimeout(()=>reject(new Error('QuickJS execution timed out')),15000);
          worker.on('error',error=>{clearTimeout(timer);reject(error)});
          worker.on('message',message=>{
            if(message.type==='ready') worker.postMessage({type:'execute',source,inputJson:'{"n":41}',timeoutMs:1000,invokeMain:true,memoryLimitBytes:16777216,stackLimitBytes:1048576});
            else if(message.type==='result'){clearTimeout(timer);resolve(message.result)}
          });
        });
        assert.equal(result.code,expectedCode);
        if(result.ok)assert.equal(JSON.parse(result.json).answer,42);
        else assert.ok(result.message.length>0);
      } finally {await worker.terminate()}
    }
    await quickjs('function main(input) { return {answer:input.n+1}; }','ready');
    await quickjs('function main(input) { throw new Error("packaging-canary"); }','runtime_error');
    process.stdout.write('packaged-runtime-resources-ok');
  `;
    await build({
      stdin: { contents: source, resolveDir: fileURLToPath(new URL("../", import.meta.url)) },
      outfile: probe,
      bundle: true,
      platform: "node",
      target: "node22",
      format: "esm",
      minify: true,
      keepNames: true,
      logLevel: "silent",
      banner: {
        js: 'import {createRequire as __pragmaCreateRequire} from "node:module";const require=__pragmaCreateRequire(import.meta.url);',
      },
    });
    // Worker and command-client policy is checked separately by the CLI auditor.
    if (!statFile(archive, join("out", "main", "desktop-cli", "cli.js")).unpacked)
      throw new Error("CLI probe directory must be outside ASAR.");
    const result = await execute(executable, [probe, resources], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        PRAGMA_HOME: home,
        PATH: "",
        NODE_OPTIONS: "",
        NODE_PATH: "",
        NODE_NO_WARNINGS: "1",
      },
      timeout: 60_000,
      cwd: home,
    });
    if (!result.stdout.includes("packaged-runtime-resources-ok"))
      throw new Error("Packaged resource smoke did not complete.");
    return {
      keyring: "passed",
      sharp: "passed",
      tokenizer: "passed",
      quickjs: "passed",
      pluginLoader: "passed",
      sdkResources: "passed",
    };
  } finally {
    await rm(probe, { force: true });
    await rm(home, { recursive: true, force: true });
  }
}
