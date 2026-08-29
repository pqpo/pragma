/* global clearTimeout, process, setTimeout */

import { execFileSync, spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const options = parseArguments(process.argv.slice(2));
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../");
const loader = resolveTsxLoader(repositoryRoot);
const startedAt = new Date();
const rounds = [];
const preservedRoots = [];

try {
  for (let round = 1; round <= options.rounds; round += 1) {
    const root = await mkdtemp(join(tmpdir(), "pragma-m10-performance-"));
    const isolation = await createIsolation(root);
    let keepRoot = false;
    try {
      if (options.mode === "inbox" || options.mode === "all") {
        rounds.push(await runInboxRound({ isolation, round }));
      }
      if (options.mode === "watch" || options.mode === "all") {
        rounds.push(await runWatchRound({ isolation, round }));
      }
    } catch (error) {
      keepRoot = true;
      preservedRoots.push(root);
      throw error;
    } finally {
      if (!keepRoot) await rm(root, { recursive: true, force: true });
    }
  }
  const evidence = createEvidence({
    options,
    startedAt,
    endedAt: new Date(),
    rounds,
    failures: 0,
  });
  await writeEvidence(options.evidenceFile, evidence);
  process.stdout.write(`${JSON.stringify(evidence)}\n`);
} catch (error) {
  const failure = {
    format: "pragma.m10.performance/v1",
    status: "failed",
    command: { executable: process.execPath, args: process.argv.slice(1) },
    error: sanitizeOutput(error instanceof Error ? error.message : String(error)),
    runtime: runtimeInfo(),
    startedAt: startedAt.toISOString(),
    endedAt: new Date().toISOString(),
    rounds,
    preservedRoots,
  };
  assertNoSecret(failure);
  await writeEvidence(options.evidenceFile, failure);
  process.stderr.write(`${JSON.stringify(failure)}\n`);
  process.exitCode = 1;
}

async function runInboxRound({ isolation, round }) {
  const missionId = deterministicUuid(1000 + round);
  const fixture = fixturePath(repositoryRoot);
  const processes = [];
  const seedArgs = [fixture, isolation.missionsPath, "seed", missionId];
  const seedResult = await runChild(seedArgs, isolation, { timeoutMs: options.timeoutMs });
  processes.push(processEvidence(seedArgs, seedResult));

  const ownerArgs = [
    fixture,
    isolation.missionsPath,
    "inbox-owner",
    missionId,
    String(options.leaseMs),
    String(options.initialDelayMs),
    String(options.maxDelayMs),
    String(options.renewEveryMs),
  ];
  const owner = startChild(ownerArgs, isolation);
  let producer;
  try {
    await owner.waitFor("OWNER_READY", options.timeoutMs);
    if (options.idleMs > 0) await delay(options.idleMs);
    const producerArgs = [
      fixture,
      isolation.missionsPath,
      "inbox-producer",
      missionId,
      String(options.requests),
      String(options.producerDelayMs),
      String(options.timeoutMs),
    ];
    producer = startChild(producerArgs, isolation);
    const records = [];
    for await (const line of producer.lines(options.timeoutMs)) {
      if (line.startsWith("BENCH_RECORD "))
        records.push(JSON.parse(line.slice("BENCH_RECORD ".length)));
      if (line.startsWith("PRODUCER_DONE ")) break;
    }
    const producerResult = await producer.waitForExit(options.timeoutMs);
    processes.push(processEvidence(producerArgs, producerResult));
    owner.write("stop\n");
    await owner.waitFor("OWNER_DONE", options.timeoutMs);
    const ownerResult = await owner.waitForExit(options.timeoutMs);
    processes.push(processEvidence(ownerArgs, ownerResult));
    return {
      kind: "inbox",
      round,
      mode: options.idleMs > 0 ? "idle-after-max-backoff" : "continuous",
      requests: options.requests,
      records,
      failures: records.filter((record) => record.state !== "applied").length,
      latencyMs: records.map(
        (record) => Date.parse(record.updatedAt) - Date.parse(record.createdAt),
      ),
      processes,
      isolation: isolationSummary(isolation),
    };
  } finally {
    await producer?.stop();
    await owner.stop();
  }
}

async function runWatchRound({ isolation, round }) {
  const missionId = deterministicUuid(2000 + round);
  const fixture = fixturePath(repositoryRoot);
  const processes = [];
  const seedArgs = [fixture, isolation.missionsPath, "seed", missionId];
  const seedResult = await runChild(seedArgs, isolation, { timeoutMs: options.timeoutMs });
  processes.push(processEvidence(seedArgs, seedResult));
  const watcherArgs = [
    fixture,
    isolation.missionsPath,
    "watcher",
    missionId,
    String(options.sampleIntervalMs),
  ];
  const watcher = startChild(watcherArgs, isolation);
  try {
    await watcher.waitFor("WATCH_READY", options.timeoutMs);
    const storageBefore = await missionStorageSnapshot(isolation, missionId);
    await delay(options.warmupMs);
    watcher.write("start-sampling\n");
    await watcher.waitFor("WATCH_SAMPLING_STARTED", options.timeoutMs);
    await delay(options.steadyMs);
    watcher.write("stop-sampling\n");
    const stopped = await watcher.waitFor("WATCH_SAMPLING_STOPPED", options.timeoutMs);
    watcher.kill("SIGINT");
    const done = await watcher.waitFor("WATCH_DONE", options.timeoutMs);
    const watcherResult = await watcher.waitForExit(options.timeoutMs);
    processes.push(processEvidence(watcherArgs, watcherResult));
    const samples = JSON.parse(stopped.slice("WATCH_SAMPLING_STOPPED ".length));
    const payload = JSON.parse(done.slice("WATCH_DONE ".length));
    const storageAfter = await missionStorageSnapshot(isolation, missionId);
    if (payload.result.status !== "detached")
      throw new Error("Watch benchmark did not detach cleanly.");
    if (samples.length < 2)
      throw new Error("Watch benchmark did not collect enough steady samples.");
    if (JSON.stringify(storageBefore) !== JSON.stringify(storageAfter))
      throw new Error("Watch benchmark mutated Mission storage during the read-only window.");
    const finalSample = samples.at(-1);
    if (!finalSample || finalSample.rssBytes <= 0)
      throw new Error("Watch benchmark lacks a final RSS sample.");
    const firstSample = samples[0];
    const steadyDurationMs = Math.max(1, finalSample.elapsedMs - firstSample.elapsedMs);
    const cpuUserMicros = finalSample.cpuUserMicros - firstSample.cpuUserMicros;
    const cpuSystemMicros = finalSample.cpuSystemMicros - firstSample.cpuSystemMicros;
    return {
      kind: "watch",
      round,
      warmupMs: options.warmupMs,
      steadyMs: options.steadyMs,
      sampleIntervalMs: options.sampleIntervalMs,
      samples,
      finalRssBytes: finalSample.rssBytes,
      steadyDurationMs,
      cpuUserMicros,
      cpuSystemMicros,
      cpuPercent: ((cpuUserMicros + cpuSystemMicros) / 1_000 / steadyDurationMs) * 100,
      storage: { before: storageBefore, after: storageAfter, changed: false },
      processes,
      isolation: isolationSummary(isolation),
    };
  } finally {
    await watcher.stop();
  }
}

function createEvidence({
  options: selected,
  startedAt: start,
  endedAt: end,
  rounds: results,
  failures,
}) {
  const evidence = {
    format: "pragma.m10.performance/v1",
    status: failures === 0 ? "passed" : "failed",
    command: { executable: process.execPath, args: process.argv.slice(1) },
    reproductionCommand: [process.execPath, ...process.argv.slice(1)].join(" "),
    commit: gitCommit(),
    runtime: runtimeInfo(),
    timing: {
      startedAt: start.toISOString(),
      endedAt: end.toISOString(),
      durationMs: end.getTime() - start.getTime(),
    },
    options: {
      mode: selected.mode,
      rounds: selected.rounds,
      requests: selected.requests,
      warmupMs: selected.warmupMs,
      steadyMs: selected.steadyMs,
      sampleIntervalMs: selected.sampleIntervalMs,
    },
    rounds: results,
    failures,
  };
  assertNoSecret(evidence);
  return evidence;
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
  isolation.missionsPath = join(isolation.pragmaHome, "data", "missions");
  await mkdir(isolation.missionsPath, { recursive: true });
  return isolation;
}

function isolationEnvironment(isolation) {
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
    NODE_NO_WARNINGS: "1",
  };
}

function startChild(args, isolation) {
  const startedAt = new Date();
  const child = spawn(process.execPath, ["--import", loader, ...args], {
    cwd: repositoryRoot,
    env: isolationEnvironment(isolation),
    stdio: ["pipe", "pipe", "pipe"],
    detached: process.platform !== "win32",
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  const lines = [];
  const waiters = [];
  let closeResult;
  let childError;
  let buffered = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
    buffered += chunk;
    while (true) {
      const index = buffered.indexOf("\n");
      if (index < 0) break;
      const line = buffered.slice(0, index).replace(/\r$/u, "");
      buffered = buffered.slice(index + 1);
      const waiter = waiters.shift();
      if (waiter) waiter.resolve(line);
      else lines.push(line);
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const processResult = new Promise((resolveResult, rejectResult) => {
    child.once("error", (error) => {
      childError = error;
      rejectAllWaiters(error);
      rejectResult(error);
    });
    child.once("close", (code, signal) => {
      closeResult = { code, signal };
      rejectAllWaiters(childExitError(closeResult, stderr));
      resolveResult(closeResult);
    });
  });
  void processResult.catch(() => undefined);
  return {
    write: (value) => child.stdin.write(value),
    async waitFor(prefix, timeoutMs) {
      for (;;) {
        const line = await nextChildLine(timeoutMs);
        if (line.startsWith(prefix)) return line;
      }
    },
    async *lines(timeoutMs) {
      while (true) {
        const line = await nextChildLine(timeoutMs);
        yield line;
        if (line.startsWith("PRODUCER_DONE ")) return;
      }
    },
    async waitForExit(timeoutMs) {
      const result = await withTimeout(processResult, timeoutMs, () => killProcessTree(child));
      if (result.code !== 0 || result.signal !== null)
        throw new Error(`Child failed: ${JSON.stringify(result)} stderr: ${stderr}`);
      return {
        ...result,
        pid: child.pid,
        startedAt,
        endedAt: new Date(),
        stdout,
        stderr,
      };
    },
    async stop() {
      if (child.exitCode === null && child.signalCode === null) killProcessTree(child);
      try {
        await withTimeout(processResult, 5_000, () => killProcessTree(child));
      } catch {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      }
    },
    kill(signal) {
      killProcessTree(child, signal);
    },
    get output() {
      return { stdout, stderr };
    },
  };

  function nextChildLine(timeoutMs) {
    return nextLine(
      lines,
      waiters,
      timeoutMs,
      () => killProcessTree(child),
      () => {
        if (childError !== undefined) return childError;
        if (closeResult !== undefined) return childExitError(closeResult, stderr);
        return undefined;
      },
    );
  }

  function rejectAllWaiters(error) {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  }
}

async function runChild(args, isolation, { timeoutMs }) {
  const child = startChild(args, isolation);
  try {
    return await child.waitForExit(timeoutMs);
  } finally {
    await child.stop();
  }
}

async function nextLine(lines, waiters, timeoutMs, onTimeout, getClosedError) {
  if (lines.length > 0) return lines.shift();
  const closedError = getClosedError?.();
  if (closedError !== undefined) throw closedError;
  const result = await withTimeout(
    new Promise((resolve, reject) => waiters.push({ resolve, reject })),
    timeoutMs,
    onTimeout,
  );
  return result;
}

function childExitError(result, stderr) {
  return new Error(
    `Child exited before producing the expected line: ${JSON.stringify(result)} stderr: ${stderr}`,
  );
}

function withTimeout(promise, timeoutMs, onTimeout) {
  return new Promise((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      onTimeout();
      rejectResult(new Error(`Timed out after ${timeoutMs}ms.`));
    }, timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolveResult(value);
      },
      (error) => {
        clearTimeout(timer);
        rejectResult(error);
      },
    );
  });
}

function killProcessTree(child, signal = "SIGKILL") {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32")
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    else process.kill(-child.pid, signal);
  } catch {
    // Child exit may race with cleanup.
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) throw new Error(`Unexpected argument: ${argument}`);
    const key = argument.slice(2);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`${argument} requires a value.`);
    values.set(key, value);
    index += 1;
  }
  const mode = values.get("mode") ?? "all";
  if (!["inbox", "watch", "all"].includes(mode))
    throw new Error("--mode must be inbox, watch, or all.");
  return {
    mode,
    rounds: positive(values.get("rounds") ?? "3", "rounds"),
    requests: positive(values.get("requests") ?? "100", "requests"),
    warmupMs: positive(values.get("warmup-ms") ?? "5000", "warmup-ms"),
    steadyMs: positive(values.get("steady-ms") ?? "60000", "steady-ms"),
    sampleIntervalMs: positive(values.get("sample-ms") ?? "1000", "sample-ms"),
    idleMs: nonNegative(values.get("idle-ms") ?? "0", "idle-ms"),
    producerDelayMs: nonNegative(values.get("producer-delay-ms") ?? "0", "producer-delay-ms"),
    initialDelayMs: positive(values.get("initial-delay-ms") ?? "25", "initial-delay-ms"),
    maxDelayMs: positive(values.get("max-delay-ms") ?? "250", "max-delay-ms"),
    leaseMs: positive(values.get("lease-ms") ?? "60000", "lease-ms"),
    renewEveryMs: positive(values.get("renew-every-ms") ?? "10000", "renew-every-ms"),
    timeoutMs: positive(values.get("timeout-ms") ?? "120000", "timeout-ms"),
    evidenceFile: values.get("evidence-file"),
  };
}

function positive(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be positive.`);
  return parsed;
}

function nonNegative(value, name) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be non-negative.`);
  return parsed;
}

async function writeEvidence(path, value) {
  if (path === undefined) return;
  await mkdir(dirname(resolve(path)), { recursive: true });
  await writeFile(resolve(path), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function fixturePath(root) {
  return join(root, "packages", "local-host", "test", "fixtures", "m10-performance-fixture.ts");
}

function resolveTsxLoader(root) {
  const launcher = requireText(join(root, "node_modules", ".bin", "tsx"));
  const match = launcher.match(/node_modules[\\/]\.pnpm[\\/]([^\\/]+)[\\/]node_modules[\\/]tsx/u);
  if (!match?.[1]) throw new Error("Could not locate the repository tsx loader.");
  return join(root, "node_modules", ".pnpm", match[1], "node_modules", "tsx", "dist", "loader.mjs");
}

function requireText(path) {
  return readFileSync(path, "utf8");
}

function runtimeInfo() {
  return { node: process.versions.node, platform: process.platform, arch: process.arch };
}

function processEvidence(args, result) {
  const stdout = sanitizeOutput(result.stdout);
  const stderr = sanitizeOutput(result.stderr);
  return {
    command: { executable: process.execPath, args: ["--import", loader, ...args] },
    timing: {
      startedAt: result.startedAt.toISOString(),
      endedAt: result.endedAt.toISOString(),
      durationMs: result.endedAt.getTime() - result.startedAt.getTime(),
    },
    process: { pid: result.pid, exitCode: result.code, signal: result.signal, timedOut: false },
    output: {
      stdout,
      stderr,
      stdoutTruncated: result.stdout.length > 16_384,
      stderrTruncated: result.stderr.length > 16_384,
    },
  };
}

async function missionStorageSnapshot(isolation, missionId) {
  const directory = join(isolation.missionsPath, missionId, "local-host");
  const files = {};
  for (const name of ["aggregate.json", "events.jsonl", "command-inbox.json"]) {
    try {
      const details = await stat(join(directory, name));
      files[name] = { bytes: details.size, modifiedAtMs: details.mtimeMs };
    } catch (error) {
      if (error?.code === "ENOENT") files[name] = null;
      else throw error;
    }
  }
  return files;
}

function sanitizeOutput(value) {
  const redacted = value.replace(
    /(authorization|api[_-]?key|password|secret|token|ciphertext)\s*[:=]\s*[^\s,}]+/giu,
    "$1=[REDACTED]",
  );
  return redacted.length > 16_384 ? redacted.slice(0, 16_384) : redacted;
}

function gitCommit() {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repositoryRoot,
      encoding: "utf8",
    }).trim();
  } catch {
    return "unknown";
  }
}

function isolationSummary(isolation) {
  return {
    root: isolation.root,
    pragmaHome: isolation.pragmaHome,
    workspace: isolation.workspace,
    npmPrefix: isolation.npmPrefix,
  };
}

function deterministicUuid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, "0")}`;
}

function assertNoSecret(value) {
  const encoded = JSON.stringify(value);
  if (/M10_SECRET_CANARY|secret-canary|api[_-]?key|token/iu.test(encoded))
    throw new Error("Performance evidence contains a secret-shaped value.");
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
