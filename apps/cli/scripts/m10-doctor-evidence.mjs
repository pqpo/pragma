/* global clearTimeout, process, setTimeout */

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const cliEntry = join(repositoryRoot, "apps/cli/dist/pragma.js");
const MAX_CAPTURED_OUTPUT = 16_384;
const command = {
  executable: process.execPath,
  args: [relative(repositoryRoot, cliEntry), "doctor"],
};
const options = parseArguments(process.argv.slice(2));
const startedAt = new Date();
const serial = [];
const concurrent = [];

try {
  for (const keychainStatus of options.statuses) {
    for (let index = 1; index <= options.rounds; index += 1) {
      serial.push(await runRound("serial", index, keychainStatus));
    }
  }
  for (const keychainStatus of options.statuses) {
    concurrent.push(
      ...(await Promise.all(
        Array.from({ length: options.concurrent }, (_, offset) =>
          runRound("concurrent", offset + 1, keychainStatus),
        ),
      )),
    );
  }

  const failures = [...serial, ...concurrent].filter((round) => round.status === "failed");
  const evidence = createEvidence({
    startedAt,
    endedAt: new Date(),
    serial,
    concurrent,
    failures: failures.length,
  });
  await writeEvidence(options.output, evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  const failure = {
    format: "pragma.m10.doctor/v1",
    status: "failed",
    command,
    reproductionCommand: reproductionCommand(),
    commit: gitCommit(),
    runtime: runtimeInfo(),
    timing: {
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      durationMs: Date.now() - startedAt.getTime(),
    },
    serial,
    concurrent,
    failures: 1,
    error: sanitize(String(error)),
  };
  assertNoSecret(failure);
  await writeEvidence(options.output, failure);
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}

async function runRound(mode, index, keychainStatus) {
  const root = await mkdtemp(join(tmpdir(), "pragma-m10-doctor-"));
  const isolation = await createIsolation(root);
  const roundStartedAt = new Date();
  let result;
  try {
    result = await invokeDoctor(isolation, keychainStatus);
  } catch (error) {
    result = {
      exitCode: null,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: String(error),
    };
  }
  const roundEndedAt = new Date();
  const output = { stdout: sanitize(result.stdout), stderr: sanitize(result.stderr) };
  const expectedCode = keychainStatus === "locked" ? "SECRET_STORE_LOCKED" : "KEYCHAIN_UNAVAILABLE";
  const passed =
    result.exitCode === 5 &&
    result.signal === null &&
    !result.timedOut &&
    output.stderr === "" &&
    output.stdout.includes(expectedCode);
  const round = {
    mode,
    index,
    keychainStatus,
    status: passed ? "passed" : "failed",
    phase: "doctor",
    command,
    reproductionCommand: reproductionCommand(isolation, keychainStatus),
    timing: {
      startedAt: roundStartedAt.toISOString(),
      endedAt: roundEndedAt.toISOString(),
      durationMs: roundEndedAt.getTime() - roundStartedAt.getTime(),
    },
    process: {
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
    },
    isolation: {
      root: isolation.root,
      pragmaHome: isolation.pragmaHome,
      workspace: isolation.workspace,
      npmPrefix: isolation.npmPrefix,
      cleanup: passed ? "completed" : "preserved",
    },
    output: {
      stdout: output.stdout,
      stderr: output.stderr,
      stdoutTruncated: result.stdout.length > MAX_CAPTURED_OUTPUT,
      stderrTruncated: result.stderr.length > MAX_CAPTURED_OUTPUT,
    },
  };
  if (passed) await rm(root, { recursive: true, force: true });
  return round;
}

async function createIsolation(root) {
  const isolation = {
    root,
    home: join(root, "home"),
    pragmaHome: join(root, "pragma-home"),
    workspace: join(root, "workspace"),
    npmPrefix: join(root, "npm-prefix"),
    npmCache: join(root, "npm-cache"),
  };
  await Promise.all(
    Object.values(isolation)
      .slice(1)
      .map((path) => mkdir(path, { recursive: true })),
  );
  return isolation;
}

function isolationEnvironment(isolation, keychainStatus) {
  return {
    ...process.env,
    HOME: isolation.home,
    USERPROFILE: isolation.home,
    APPDATA: join(isolation.home, "AppData", "Roaming"),
    LOCALAPPDATA: join(isolation.home, "AppData", "Local"),
    PRAGMA_HOME: isolation.pragmaHome,
    M10_WORKSPACE: isolation.workspace,
    NPM_CONFIG_PREFIX: isolation.npmPrefix,
    npm_config_prefix: isolation.npmPrefix,
    NPM_CONFIG_CACHE: isolation.npmCache,
    npm_config_cache: isolation.npmCache,
    NODE_ENV: "test",
    PRAGMA_CLI_TEST_KEYCHAIN_STATUS: keychainStatus,
    NODE_NO_WARNINGS: "1",
  };
}

function invokeDoctor(isolation, keychainStatus) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [cliEntry, "doctor"], {
      cwd: repositoryRoot,
      env: isolationEnvironment(isolation, keychainStatus),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let forceTimer;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child);
      forceTimer = setTimeout(() => {
        try {
          killProcessTree(child);
        } catch {
          // The process may have exited between tree termination and fallback.
        }
      }, 1_000);
    }, options.timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", (error) => {
      stderr += error instanceof Error ? error.message : String(error);
      finish(null, null);
    });
    child.once("close", (exitCode, signal) => finish(exitCode, signal));

    function finish(exitCode, signal) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      resolveResult({ exitCode, signal, timedOut, stdout, stderr });
    }
  });
}

function createEvidence({
  startedAt: start,
  endedAt: end,
  serial: serialRounds,
  concurrent: concurrentRounds,
  failures,
}) {
  const evidence = {
    format: "pragma.m10.doctor/v1",
    status: failures === 0 ? "passed" : "failed",
    command,
    reproductionCommand: reproductionCommand(),
    commit: gitCommit(),
    runtime: runtimeInfo(),
    timing: {
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      durationMs: end.getTime() - start.getTime(),
    },
    options: {
      serialRounds: options.rounds,
      concurrentRounds: options.concurrent,
      timeoutMs: options.timeoutMs,
      statuses: options.statuses,
    },
    serial: serialRounds,
    concurrent: concurrentRounds,
    failures,
  };
  assertNoSecret(evidence);
  return evidence;
}

async function writeEvidence(path, evidence) {
  if (path === undefined) return;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
}

function reproductionCommand(isolation, keychainStatus) {
  const environment = [
    "NODE_ENV=test",
    `PRAGMA_CLI_TEST_KEYCHAIN_STATUS=${keychainStatus ?? "locked"}`,
    ...(isolation === undefined ? [] : [`PRAGMA_HOME=${shellQuote(isolation.pragmaHome)}`]),
  ].join(" ");
  return `cd ${shellQuote(repositoryRoot)} && ${environment} ${shellQuote(process.execPath)} ${command.args.map(shellQuote).join(" ")}`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function runtimeInfo() {
  return { node: process.version, platform: process.platform, arch: process.arch };
}

function gitCommit() {
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function sanitize(value) {
  const redacted = value
    .replace(
      /(authorization|api[_-]?key|password|secret|token|ciphertext)\s*[:=]\s*[^\s,}]+/giu,
      "$1=[REDACTED]",
    )
    .replaceAll("\u001b", "");
  return redacted.length > MAX_CAPTURED_OUTPUT ? redacted.slice(0, MAX_CAPTURED_OUTPUT) : redacted;
}

function assertNoSecret(value) {
  const serialized = JSON.stringify(value);
  if (/M10_SECRET_CANARY|doctor-secret-canary|ciphertext-must-not-leak/iu.test(serialized)) {
    throw new Error("Doctor evidence contains a secret canary.");
  }
}

function killProcessTree(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    // Child exit may race with timeout cleanup.
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--help") {
      process.stdout.write(
        "Usage: node scripts/m10-doctor-evidence.mjs [--status locked,unavailable] [--rounds N] [--concurrent N] [--timeout-ms N] [--output PATH]\n",
      );
      process.exit(0);
    }
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${argument} requires a value.`);
    values.set(argument.slice(2), value);
    index += 1;
  }
  return {
    rounds: positive(values.get("rounds") ?? "10", "rounds"),
    concurrent: positive(values.get("concurrent") ?? "10", "concurrent"),
    timeoutMs: positive(values.get("timeout-ms") ?? "30000", "timeout-ms"),
    output: values.get("output") === undefined ? undefined : resolve(values.get("output")),
    statuses: parseStatuses(values.get("status") ?? "locked,unavailable"),
  };
}

function parseStatuses(value) {
  const statuses = value.split(",");
  if (
    statuses.length === 0 ||
    statuses.length !== new Set(statuses).size ||
    statuses.some((status) => status !== "locked" && status !== "unavailable")
  )
    throw new Error("--status must contain locked and/or unavailable, separated by commas.");
  return statuses;
}

function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive.`);
  return parsed;
}
