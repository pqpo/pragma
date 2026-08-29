import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import process from "node:process";

const options = parseArguments(process.argv.slice(2));
const artifactDirectory = resolve(options.artifactDirectory);
const artifactManifest = JSON.parse(
  await readFile(join(artifactDirectory, "artifact-manifest.json"), "utf8"),
);
if (
  artifactManifest.package !== "@pqpo/pragma" ||
  artifactManifest.tarball !== "pragma-cli.tgz" ||
  typeof artifactManifest.version !== "string" ||
  !/^[a-f0-9]{64}$/u.test(artifactManifest.sha256)
) {
  throw new Error(`Invalid canonical artifact manifest: ${JSON.stringify(artifactManifest)}`);
}
const tarballPath = join(artifactDirectory, artifactManifest.tarball);
const tarball = await readFile(tarballPath);
const actualSha256 = createHash("sha256").update(tarball).digest("hex");
if (actualSha256 !== artifactManifest.sha256) {
  throw new Error(
    `Canonical tarball digest mismatch: expected ${artifactManifest.sha256}, got ${actualSha256}.`,
  );
}
const checksumLine = await readFile(join(artifactDirectory, "SHA256SUMS.txt"), "utf8");
const checksum = checksumLine.trim().split(/\s+/u);
if (checksum[0] !== actualSha256 || checksum[1] !== "pragma-cli.tgz") {
  throw new Error(`SHA256SUMS.txt does not match the canonical tarball: ${checksumLine}`);
}

const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0] ?? "", 10);
if (options.mode === "positive" && nodeMajor < 22) {
  throw new Error(`Positive smoke requires Node.js 22+, detected ${process.versions.node}.`);
}
if (options.mode === "node20" && nodeMajor !== 20) {
  throw new Error(
    `Node 20 negative smoke must run on Node.js 20, detected ${process.versions.node}.`,
  );
}
if (options.mode === "linux" && process.platform !== "linux") {
  throw new Error(`Linux OS negative smoke must run on Linux, detected ${process.platform}.`);
}
if (options.mode !== "linux" && process.platform !== "darwin" && process.platform !== "win32") {
  throw new Error(
    `Positive and Node 20 smoke require macOS or Windows, detected ${process.platform}.`,
  );
}

const smokeRoot = await mkdtemp(join(tmpdir(), "pragma-cli-smoke-"));
try {
  const environment = createIsolatedEnvironment(smokeRoot, options.npmCache);
  if (options.mode === "positive") {
    await runPositiveSmoke({
      smokeRoot,
      environment,
      tarballPath,
      version: artifactManifest.version,
    });
  } else if (options.mode === "node20") {
    await runNode20NegativeSmoke({ smokeRoot, environment, tarballPath });
  } else {
    await runLinuxNegativeSmoke({ smokeRoot, environment, tarballPath });
  }
  process.stdout.write(
    JSON.stringify(
      {
        ok: true,
        mode: options.mode,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        version: artifactManifest.version,
        tarballSha256: actualSha256,
      },
      null,
      2,
    ) + "\n",
  );
} finally {
  await rm(smokeRoot, { recursive: true, force: true });
}

function parseArguments(argv) {
  const values = new Map();
  const normalizedArgv = argv[0] === "--" ? argv.slice(1) : argv;
  for (let index = 0; index < normalizedArgv.length; index += 1) {
    const argument = normalizedArgv[index];
    if (argument === "--mode" || argument === "--artifact-dir" || argument === "--npm-cache") {
      const value = normalizedArgv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error(`${argument} requires a value.`);
      }
      values.set(argument.slice(2), value);
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  const mode = values.get("mode");
  if (mode !== "positive" && mode !== "node20" && mode !== "linux") {
    throw new Error(
      "Usage: node scripts/smoke-package.mjs --mode <positive|node20|linux> --artifact-dir <dir>",
    );
  }
  const artifactDirectory = values.get("artifact-dir");
  if (artifactDirectory === undefined) throw new Error("--artifact-dir is required.");
  return { mode, artifactDirectory, npmCache: values.get("npm-cache") };
}

function createIsolatedEnvironment(smokeRoot, npmCacheOverride) {
  const home = join(smokeRoot, "用户 home");
  const pragmaHome = join(smokeRoot, "Pragma 数据根");
  const npmCache =
    npmCacheOverride === undefined ? join(smokeRoot, "npm cache") : resolve(npmCacheOverride);
  const userConfig = join(smokeRoot, "npmrc");
  const basePath = process.env.PATH ?? "";
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: join(home, "AppData", "Roaming"),
    LOCALAPPDATA: join(home, "AppData", "Local"),
    PRAGMA_HOME: pragmaHome,
    NPM_CONFIG_CACHE: npmCache,
    npm_config_cache: npmCache,
    NPM_CONFIG_USERCONFIG: userConfig,
    npm_config_userconfig: userConfig,
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_audit: "false",
    NPM_CONFIG_ENGINE_STRICT: "false",
    npm_config_engine_strict: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    npm_config_prefer_offline: "true",
    PATH: basePath,
  };
}

async function runPositiveSmoke({ smokeRoot, environment, tarballPath, version }) {
  const prefix = join(smokeRoot, "全局 前缀");
  const binDirectory = getBinDirectory(prefix);
  const firstInstall = await installPackage(prefix, tarballPath, environment);
  assertExit(firstInstall, 0, "npm install @pqpo/pragma");
  const installedEnvironment = withPathPrefix(environment, binDirectory);

  const packageRoot = await getNpmRoot(prefix, environment);
  const installedManifest = JSON.parse(
    await readFile(join(packageRoot, "@pqpo", "pragma", "package.json"), "utf8"),
  );
  if (installedManifest.version !== version) {
    throw new Error(
      `Installed version mismatch: expected ${version}, got ${installedManifest.version}.`,
    );
  }
  await assertInstalledShim(prefix, binDirectory);

  await assertPragmaCommand(["version"], installedEnvironment, (result) => {
    assertExit(result, 0, "pragma version");
    if (!result.stdout.includes(`pragma ${version}`)) {
      throw new Error(`pragma version did not report ${version}:\n${result.stdout}`);
    }
  });
  await assertPragmaCommand(["--help"], installedEnvironment, (result) =>
    assertExit(result, 0, "pragma --help"),
  );
  await assertPragmaCommand(["doctor"], installedEnvironment, (result) =>
    assertExit(result, 0, "pragma doctor"),
  );
  await assertPragmaCommand(
    ["expert", "discover", "--format=json"],
    installedEnvironment,
    (result) => {
      assertExit(result, 0, "pragma expert discover");
      assertJsonResult(result, "expert.discover");
    },
  );
  await assertPragmaCommand(
    ["team", "discover", "--format=json"],
    installedEnvironment,
    (result) => {
      assertExit(result, 0, "pragma team discover");
      assertJsonResult(result, "team.discover");
    },
  );
  await assertPragmaCommand(
    ["flow", "discover", "--format=json"],
    installedEnvironment,
    (result) => {
      assertExit(result, 0, "pragma flow discover");
      assertJsonResult(result, "flow.discover");
    },
  );
  await assertPragmaCommand(
    ["mission", "list", "--format=json"],
    installedEnvironment,
    (result) => {
      assertExit(result, 0, "pragma mission list");
      assertJsonResult(result, "mission.list");
    },
  );

  const directResult = await runCommand(
    process.execPath,
    [join(packageRoot, "@pqpo", "pragma", "dist", "pragma.js"), "version"],
    {
      cwd: smokeRoot,
      env: environment,
    },
  );
  assertExit(directResult, 0, "direct packaged pragma bin");

  const reinstall = await installPackage(prefix, tarballPath, environment);
  assertExit(reinstall, 0, "npm reinstall @pqpo/pragma");
  await assertPragmaCommand(["version"], installedEnvironment, (result) =>
    assertExit(result, 0, "pragma version after reinstall"),
  );

  await assertPathPrecedence({ smokeRoot, environment, binDirectory, version });

  const uninstallResult = await runNpm(
    ["uninstall", "--global", "--prefix", prefix, "@pqpo/pragma"],
    environment,
  );
  assertExit(uninstallResult, 0, "npm uninstall @pqpo/pragma");
  if (await pathExists(join(binDirectory, getBinName()))) {
    throw new Error("npm uninstall left the pragma command shim behind.");
  }
  if (await pathExists(join(packageRoot, "@pqpo", "pragma"))) {
    throw new Error("npm uninstall left @pqpo/pragma in the isolated npm root.");
  }
}

async function runNode20NegativeSmoke({ smokeRoot, environment, tarballPath }) {
  const prefix = join(smokeRoot, "Node20 前缀");
  const installResult = await installPackage(prefix, tarballPath, environment);
  assertExit(installResult, 0, "Node 20 non-strict install");
  const installedEnvironment = withPathPrefix(environment, getBinDirectory(prefix));
  if (!/EBADENGINE|Unsupported engine|requires a peer of/iu.test(combinedOutput(installResult))) {
    throw new Error(
      `Node 20 install did not emit an engine warning:\n${combinedOutput(installResult)}`,
    );
  }

  await assertPragmaCommand(["version"], installedEnvironment, (result) => {
    if (result.code !== 2 || !/requires Node\.js 22 or later/iu.test(result.stderr)) {
      throw new Error(
        `Node 20 bootstrap did not reject before loading the main bundle (exit ${result.code}):\n${combinedOutput(result)}`,
      );
    }
  });

  const strictPrefix = join(smokeRoot, "Node20 strict 前缀");
  const strictResult = await installPackage(strictPrefix, tarballPath, {
    ...environment,
    NPM_CONFIG_ENGINE_STRICT: "true",
    npm_config_engine_strict: "true",
  });
  if (
    strictResult.code === 0 ||
    !/EBADENGINE|Unsupported engine|not compatible/iu.test(combinedOutput(strictResult))
  ) {
    throw new Error(
      `Node 20 engine-strict installation unexpectedly succeeded or returned the wrong error:\n${combinedOutput(strictResult)}`,
    );
  }
}

async function runLinuxNegativeSmoke({ smokeRoot, environment, tarballPath }) {
  const prefix = join(smokeRoot, "Linux 前缀");
  const installResult = await installPackage(prefix, tarballPath, environment);
  if (
    installResult.code === 0 ||
    !/EBADPLATFORM|not compatible with your operating system|Unsupported platform/iu.test(
      combinedOutput(installResult),
    )
  ) {
    throw new Error(
      `Linux installation did not fail with EBADPLATFORM:\n${combinedOutput(installResult)}`,
    );
  }
  if (await pathExists(join(getBinDirectory(prefix), getBinName()))) {
    throw new Error("Linux negative install created a pragma command shim.");
  }
}

async function assertPathPrecedence({ smokeRoot, environment, binDirectory, version }) {
  const sentinelDirectory = join(smokeRoot, "path sentinel");
  const sentinelPath = join(sentinelDirectory, getBinName());
  await mkdir(sentinelDirectory, { recursive: true });
  await writeFile(
    sentinelPath,
    process.platform === "win32"
      ? "@echo pragma-path-sentinel\r\n"
      : "#!/bin/sh\nprintf '%s\\n' pragma-path-sentinel\n",
    "utf8",
  );
  if (process.platform !== "win32") await chmod(sentinelPath, 0o755);

  const sentinelFirst = {
    ...environment,
    PATH: `${sentinelDirectory}${delimiter}${environment.PATH ?? ""}`,
  };
  await assertPragmaCommand(["version"], sentinelFirst, (result) => {
    assertExit(result, 0, "sentinel pragma command");
    if (!result.stdout.includes("pragma-path-sentinel")) {
      throw new Error(
        `PATH sentinel was not selected before the installed CLI:\n${combinedOutput(result)}`,
      );
    }
  });

  const packageFirst = {
    ...environment,
    PATH: `${binDirectory}${delimiter}${sentinelDirectory}${delimiter}${environment.PATH ?? ""}`,
  };
  await assertPragmaCommand(["version"], packageFirst, (result) => {
    assertExit(result, 0, "installed pragma command with prefix first");
    if (!result.stdout.includes(`pragma ${version}`)) {
      throw new Error(
        `Installed CLI did not win when its npm prefix was first:\n${combinedOutput(result)}`,
      );
    }
  });
}

async function installPackage(prefix, tarballPath, environment) {
  return await runNpm(
    ["install", "--global", "--prefix", prefix, "--no-audit", "--no-fund", tarballPath],
    environment,
  );
}

async function getNpmRoot(prefix, environment) {
  const result = await runNpm(["root", "--global", "--prefix", prefix], environment);
  assertExit(result, 0, `npm root ${prefix}`);
  const lines = result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  const root = lines.at(-1);
  if (root === undefined) throw new Error(`npm root returned no path:\n${combinedOutput(result)}`);
  return root;
}

async function assertInstalledShim(prefix, binDirectory) {
  const shimPath = join(binDirectory, getBinName());
  if (!(await pathExists(shimPath)))
    throw new Error(`npm did not create the pragma shim: ${shimPath}`);
  const metadata = await stat(shimPath);
  if (process.platform !== "win32" && (metadata.mode & 0o111) === 0) {
    throw new Error(`The installed pragma shim is not executable: ${shimPath}`);
  }
}

async function assertPragmaCommand(args, environment, assertion) {
  const result = await runCommand(getPragmaCommand(), args, {
    env: environment,
    cwd: process.cwd(),
  });
  assertion(result);
}

function runNpm(args, environment) {
  return runCommand(getNpmCommand(), args, { env: environment, cwd: process.cwd() });
}

function runCommand(command, args, { cwd, env }) {
  const useShell = process.platform === "win32" && /\.cmd$/iu.test(command);
  return new Promise((resolvePromise) => {
    const child = spawn(command, useShell ? args.map(quoteWindowsShellArgument) : args, {
      cwd,
      env,
      shell: useShell,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => (stdout += chunk.toString("utf8")));
    child.stderr?.on("data", (chunk) => (stderr += chunk.toString("utf8")));
    child.once("error", (error) => {
      resolvePromise({ code: null, stdout, stderr: `${stderr}${error.message}` });
    });
    child.once("close", (code, signal) => resolvePromise({ code, signal, stdout, stderr }));
  });
}

function quoteWindowsShellArgument(argument) {
  if (!/[\s"]/u.test(argument)) return argument;
  return `"${argument.replaceAll('"', '\\"')}"`;
}

function assertExit(result, expected, label) {
  if (result.code !== expected) {
    throw new Error(
      `${label} exited with ${result.code}, expected ${expected}:\n${combinedOutput(result)}`,
    );
  }
}

function assertJsonResult(result, command) {
  const output = result.stdout.trim().split(/\r?\n/u).at(-1);
  if (output === undefined) throw new Error(`${command} returned no JSON output.`);
  let parsed;
  try {
    parsed = JSON.parse(output);
  } catch (error) {
    throw new Error(
      `${command} returned invalid JSON: ${error instanceof Error ? error.message : String(error)}\n${result.stdout}`,
      { cause: error },
    );
  }
  if (parsed.status !== "succeeded" || parsed.command !== command) {
    throw new Error(`${command} returned an unexpected protocol result: ${output}`);
  }
}

function combinedOutput(result) {
  return `${result.stdout}${result.stderr}`;
}

function getNpmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function getPragmaCommand() {
  return process.platform === "win32" ? "pragma.cmd" : "pragma";
}

function getBinDirectory(prefix) {
  return process.platform === "win32" ? prefix : join(prefix, "bin");
}

function withPathPrefix(environment, directory) {
  return {
    ...environment,
    PATH: `${directory}${delimiter}${environment.PATH ?? ""}`,
  };
}

function getBinName() {
  return process.platform === "win32" ? "pragma.cmd" : "pragma";
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
