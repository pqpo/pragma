import { loadDistribution } from "../../../scripts/distribution.mjs";
import { execFile, execFileSync } from "node:child_process";
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { extractFile, statFile } from "@electron/asar";
import { CLI_WORKERS } from "../../cli/scripts/build-bundles.mjs";
import {
  assertNoBuildPathLeaks,
  assertNoExternalWorkspaceImports,
} from "../../cli/scripts/package-audit-lib.mjs";

const execute = promisify(execFile);
const repositoryDirectory = fileURLToPath(new URL("../../../", import.meta.url));

export async function auditDesktopCli(resources, executable) {
  const { config, digest } = await loadDistribution();
  const archive = join(resources, "app.asar");
  const directory = join(`${archive}.unpacked`, "out/main/desktop-cli");
  const mainIdentity = JSON.parse(
    extractFile(archive, "out/main/distribution.json").toString("utf8"),
  );
  if (mainIdentity.distributionId !== config.id || mainIdentity.distributionDigest !== digest)
    throw new Error("Packaged Desktop main distribution does not match this release.");
  for (const name of [
    "pragma.js",
    "cli.js",
    "package.json",
    "distribution.json",
    ...Object.keys(CLI_WORKERS).map((name) => `${name}.js`),
  ]) {
    const relativePath = join("out", "main", "desktop-cli", name);
    if (!statFile(archive, relativePath).unpacked || !(await stat(join(directory, name))).isFile())
      throw new Error(`Desktop CLI must unpack ${name}.`);
    if (name.endsWith(".js")) {
      const source = await readFile(join(directory, name), "utf8");
      assertNoExternalWorkspaceImports(source, name);
      assertNoBuildPathLeaks(source, name, {
        repositoryDirectory,
        buildDirectories: [process.env.GITHUB_WORKSPACE, process.env.RUNNER_TEMP].filter(Boolean),
      });
    }
  }
  const cliPackage = JSON.parse(
    await readFile(new URL("../../cli/package.json", import.meta.url), "utf8"),
  );
  const desktopPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const distribution = JSON.parse(await readFile(join(directory, "distribution.json"), "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
  }).trim();
  if (
    distribution.cliVersion !== (config.cliVersion ?? cliPackage.version) ||
    distribution.desktopVersion !== (config.desktopVersion ?? desktopPackage.version) ||
    distribution.sourceCommit !== commit ||
    distribution.distributionDigest !== digest
  )
    throw new Error("Desktop CLI distribution identity does not match this release.");
  if (JSON.parse(await readFile(join(directory, "package.json"), "utf8")).type !== "module")
    throw new Error("Desktop CLI must be ESM.");
  const temporary = await mkdtemp(join(tmpdir(), "pragma-desktop-cli-smoke-"));
  const environment = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    PRAGMA_HOME: temporary,
    [config.homeEnvironmentVariable]: temporary,
    PATH: "",
    NODE_PATH: "",
    NODE_OPTIONS: "",
    NODE_NO_WARNINGS: "1",
  };
  try {
    const client = join(directory, "pragma.js");
    const version = await execute(executable, [client, "version", "--format", "json"], {
      env: environment,
      timeout: 30_000,
    });
    const versions = JSON.parse(version.stdout).result;
    if (
      versions.cliVersion !== (config.cliVersion ?? cliPackage.version) ||
      versions.desktopBundleVersion !== (config.desktopVersion ?? desktopPackage.version)
    )
      throw new Error("Bundled CLI reported a different CLI or Desktop version.");
    await execute(executable, [client, "--help"], { env: environment, timeout: 30_000 });
    await execute(executable, [client, "mission", "list", "--format", "json"], {
      env: environment,
      timeout: 30_000,
    });
    // Verify the shipped bootstrap consumes Electron's switch and preserves argv/exit status.
    const bootstrap = join(temporary, "pragma.js");
    await copyFile(client, bootstrap);
    await writeFile(join(temporary, "package.json"), JSON.stringify({ type: "module" }));
    await writeFile(
      join(temporary, "cli.js"),
      `export async function runCli(args, io) { let stdin = ""; for await (const chunk of process.stdin) stdin += chunk.toString(); io.writeStdout(JSON.stringify({args, stdin, electron:process.env.ELECTRON_RUN_AS_NODE ?? null})); return 7; }`,
    );
    const bootstrapResult = await new Promise((resolve) => {
      const child = execFile(
        executable,
        [bootstrap, "中文", "two words", "a'\\\"$`b"],
        { env: environment, timeout: 30_000 },
        (error, stdout, stderr) => resolve({ code: error?.code ?? 0, stdout, stderr }),
      );
      child.stdin.end("stdin 中文 with spaces\n");
    });
    if (bootstrapResult?.code !== 7 || bootstrapResult.stderr !== "")
      throw new Error("Desktop CLI bootstrap did not preserve its exit status.");
    const echoed = JSON.parse(bootstrapResult.stdout);
    if (
      echoed.electron !== null ||
      echoed.stdin !== "stdin 中文 with spaces\n" ||
      JSON.stringify(echoed.args) !== JSON.stringify(["中文", "two words", "a'\\\"$`b"])
    )
      throw new Error("Desktop CLI bootstrap leaked Electron's switch or changed arguments.");
    // Load the native keychain package through the CLI's actual resolver and exercise worker initialization.
    const probe = join(directory, "packaging-probe.mjs");
    try {
      await writeFile(
        probe,
        `import { createRequire } from 'node:module';
        import { Worker } from 'node:worker_threads';
        const require = createRequire(import.meta.url);
        const keyring = require('@napi-rs/keyring');
        if (typeof keyring.Entry !== 'function') throw new Error('Native keyring unavailable');
        for (const [file, options, request] of [
          ['code-service-worker.js', {}, null],
          ['canonical-event-feed-worker.js', {workerData:{pragmaHome:process.env.PRAGMA_HOME}}, null],
          ['vector-worker.js', {workerData:{path:process.env.PRAGMA_HOME+'/vectors.sqlite',readOnly:false}}, null],
          ['sqlite-execution-worker.js', {}, {requestId:'smoke', operation:'prepare-owner', executionId:'smoke', pragmaHome:process.env.PRAGMA_HOME}]
        ]) {
          await new Promise((resolve, reject) => {
            const worker = new Worker(new URL(file, import.meta.url), options);
            const timeout = setTimeout(() => finish(new Error(file+' timed out')), 15000);
            let finished = false;
            function finish(error) {
              if (finished) return; finished = true; clearTimeout(timeout);
              worker.terminate().then(() => error ? reject(error) : resolve());
            }
            worker.on('error', finish);
            worker.on('exit', code => {if(!finished) finish(new Error(file+' exited '+code));});
            worker.on('message', result => {
              if (request ? result.requestId === request.requestId : result.ready === true || result.type === 'ready') finish(result.ok === false ? new Error(JSON.stringify(result)) : undefined);
            });
            if(request) worker.postMessage(request);
          });
        }
        process.stdout.write('desktop-cli-workers-ok');`,
      );
      const result = await execute(executable, [probe], { env: environment, timeout: 60_000 });
      if (!result.stdout.includes("desktop-cli-workers-ok"))
        throw new Error("Desktop CLI worker smoke did not finish.");
    } finally {
      await rm(probe, { force: true });
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
  return distribution;
}
