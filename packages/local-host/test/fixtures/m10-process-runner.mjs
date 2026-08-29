/* global clearTimeout, process, setTimeout */

import { execFile, execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const fixtureDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(fixtureDirectory, "../../../..");
const fixturePath = resolve(fixtureDirectory, "m10-process-fixture.ts");
const scenarioIds = new Set(
  Array.from({ length: 15 }, (_, index) => `E${String(index + 1).padStart(2, "0")}`),
);
const outputLimit = 1024 * 1024;

const options = parseArguments(process.argv.slice(2));
const root = await mkdtemp(join(tmpdir(), "pragma-m10-"));
const paths = {
  home: join(root, "home"),
  pragmaHome: join(root, "pragma-home"),
  workspace: join(root, "workspace"),
  npmPrefix: join(root, "npm-prefix"),
  npmCache: join(root, "npm-cache"),
};
await Promise.all(Object.values(paths).map((path) => mkdir(path, { recursive: true })));

const redactionValues = new Set(
  [...options.redact, process.env.M10_SECRET_CANARY, process.env.M10_EVIDENCE_SECRET].filter(
    (value) => value !== undefined && value !== "",
  ),
);
const environment = {
  ...process.env,
  HOME: paths.home,
  USERPROFILE: paths.home,
  APPDATA: join(paths.home, "AppData", "Roaming"),
  LOCALAPPDATA: join(paths.home, "AppData", "Local"),
  PRAGMA_HOME: paths.pragmaHome,
  M10_WORKSPACE: paths.workspace,
  M10_SCENARIO_ID: options.scenario,
  NPM_CONFIG_PREFIX: paths.npmPrefix,
  npm_config_prefix: paths.npmPrefix,
  NPM_CONFIG_CACHE: paths.npmCache,
  npm_config_cache: paths.npmCache,
};

const command = buildCommand(options, paths.pragmaHome);
const startedAt = new Date();
const result = await runChild(command, environment, options.timeoutMs);
const endedAt = new Date();
const sanitizedCommand = {
  executable: redact(command.executable, redactionValues),
  args: command.args.map((argument) => redact(argument, redactionValues)),
};
const reproductionCommand = buildReproductionCommand(sanitizedCommand, paths, redactionValues);
const passed = result.exitCode === 0 && result.signal === null && !result.timedOut;
const evidence = {
  format: "pragma.m10.evidence/v1",
  scenarioId: options.scenario,
  status: passed ? "passed" : "failed",
  command: sanitizedCommand,
  reproductionCommand,
  commit: await readCommit(),
  runtime: {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
  },
  timing: {
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    durationMs: endedAt.getTime() - startedAt.getTime(),
  },
  process: {
    exitCode: result.exitCode,
    signal: result.signal,
    timedOut: result.timedOut,
  },
  isolation: {
    root,
    pragmaHome: paths.pragmaHome,
    workspace: paths.workspace,
    npmPrefix: paths.npmPrefix,
    cleanup: passed ? "completed" : "preserved",
  },
  output: {
    stdout: redact(result.stdout, redactionValues),
    stderr: redact(result.stderr, redactionValues),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
  },
};

if (options.evidenceFile !== undefined) {
  await mkdir(dirname(options.evidenceFile), { recursive: true });
  await writeFile(options.evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`);
}

if (passed) {
  await rm(root, { recursive: true, force: true });
}

process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);
if (!passed) {
  process.stderr.write(`M10 scenario failed; isolation preserved at ${root}.\n`);
  process.exitCode = 1;
}

function parseArguments(arguments_) {
  let scenario;
  let target;
  let action;
  let timeoutMs = 30_000;
  let evidenceFile;
  const values = [];
  const redactValues = [];
  let passthrough = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index];
    if (passthrough) {
      values.push(argument);
      continue;
    }
    if (argument === "--") {
      passthrough = true;
      continue;
    }
    if (argument === "--scenario") {
      scenario = requiredValue(arguments_, ++index, argument);
      continue;
    }
    if (argument === "--target") {
      target = requiredValue(arguments_, ++index, argument);
      continue;
    }
    if (argument === "--action") {
      action = requiredValue(arguments_, ++index, argument);
      continue;
    }
    if (argument === "--value") {
      values.push(requiredValue(arguments_, ++index, argument));
      continue;
    }
    if (argument === "--redact") {
      redactValues.push(requiredValue(arguments_, ++index, argument));
      continue;
    }
    if (argument === "--timeout-ms") {
      timeoutMs = Number(requiredValue(arguments_, ++index, argument));
      continue;
    }
    if (argument === "--evidence-file") {
      evidenceFile = resolve(requiredValue(arguments_, ++index, argument));
      continue;
    }
    throw new Error(`Unknown M10 runner argument: ${argument}`);
  }

  if (scenario === undefined || !scenarioIds.has(scenario)) {
    throw new Error("--scenario must be one of E01 through E15.");
  }
  if (target !== "fixture" && target !== "cli") {
    throw new Error("--target must be fixture or cli.");
  }
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive integer.");
  }
  if (target === "fixture" && action === undefined) {
    throw new Error("Fixture scenarios require --action.");
  }
  if (target === "cli" && values.length === 0) {
    throw new Error("CLI scenarios require arguments after --.");
  }
  return {
    scenario,
    target,
    action,
    timeoutMs,
    evidenceFile,
    values,
    redact: redactValues,
  };
}

function requiredValue(arguments_, index, option) {
  const value = arguments_[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value.`);
  }
  return value;
}

function buildCommand(options_, pragmaHome) {
  if (options_.target === "fixture") {
    const tsx = join(
      repositoryRoot,
      "node_modules",
      ".bin",
      process.platform === "win32" ? "tsx.cmd" : "tsx",
    );
    return {
      executable: tsx,
      args: [
        fixturePath,
        join(pragmaHome, "data", "missions"),
        options_.action,
        ...options_.values,
      ],
    };
  }
  return {
    executable: process.execPath,
    args: [join(repositoryRoot, "apps", "cli", "dist", "pragma.js"), ...options_.values],
  };
}

function runChild(command_, environment_, timeoutMs) {
  return new Promise((resolveResult) => {
    const child = spawn(command_.executable, command_.args, {
      cwd: repositoryRoot,
      env: environment_,
      windowsHide: true,
      shell: process.platform === "win32" && command_.executable.endsWith(".cmd"),
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let timedOut = false;
    let forceTimer;
    const append = (current, chunk, limit) => {
      const next = `${current}${chunk}`;
      return next.length <= limit ? next : next.slice(0, limit);
    };
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolveResult(value);
    };
    child.stdout?.on("data", (chunk) => {
      const text = String(chunk);
      if (stdout.length < outputLimit) stdout = append(stdout, text, outputLimit);
      if (stdout.length >= outputLimit) stdoutTruncated = true;
    });
    child.stderr?.on("data", (chunk) => {
      const text = String(chunk);
      if (stderr.length < outputLimit) stderr = append(stderr, text, outputLimit);
      if (stderr.length >= outputLimit) stderrTruncated = true;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, "SIGTERM");
      forceTimer = setTimeout(() => killProcessTree(child, "SIGKILL"), 1_000);
    }, timeoutMs);
    child.once("error", (error) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      stderr = `${stderr}${error instanceof Error ? error.message : String(error)}`;
      finish({
        exitCode: null,
        signal: null,
        timedOut,
        stdout,
        stderr,
        stdoutTruncated,
        stderrTruncated,
      });
    });
    child.once("close", (exitCode, signal) => {
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      finish({ exitCode, signal, timedOut, stdout, stderr, stdoutTruncated, stderrTruncated });
    });
  });
}

async function readCommit() {
  try {
    const result = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
    return result.stdout.trim();
  } catch {
    return "unknown";
  }
}

function redact(value, values) {
  return [...values]
    .sort((left, right) => right.length - left.length)
    .reduce((current, secret) => current.split(secret).join("[REDACTED]"), value);
}

function buildReproductionCommand(command_, paths_, values) {
  const assignments = [
    ["PRAGMA_HOME", paths_.pragmaHome],
    ["M10_WORKSPACE", paths_.workspace],
    ["NPM_CONFIG_PREFIX", paths_.npmPrefix],
  ];
  return [
    ...assignments.map(([name, value]) => `${name}=${shellQuote(redact(value, values))}`),
    shellQuote(command_.executable),
    ...command_.args.map((argument) => shellQuote(argument)),
  ].join(" ");
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function killProcessTree(child, signal) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else process.kill(-child.pid, signal);
  } catch {
    // The child may have exited between the timeout and tree termination.
  }
}
