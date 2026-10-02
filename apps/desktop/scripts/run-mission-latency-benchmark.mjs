// Supervise native Keychain access in a separate process: a synchronous native
// permission prompt cannot be interrupted by a timer in the benchmark process.
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("./benchmark-mission-end-to-end.mjs", import.meta.url));
const child = spawn(process.execPath, [script, ...process.argv.slice(2)], {
  stdio: ["inherit", "inherit", "inherit", "ipc"],
});
let failure;
let killTimer;
let timer = setTimeout(() => stop("MISSION_BENCHMARK_KEYCHAIN_TIMEOUT"), 120_000);
function stop(code) {
  failure = code;
  process.stderr.write(`${code}: benchmark process stopped; no valid latency result.\n`);
  child.kill("SIGTERM");
  killTimer = setTimeout(() => child.kill("SIGKILL"), 1000);
}
child.on("message", (message) => {
  if (message?.phase === "credentials-cleanup") {
    clearTimeout(timer);
    timer = setTimeout(() => stop("MISSION_BENCHMARK_KEYCHAIN_CLEANUP_TIMEOUT"), 120_000);
    return;
  }
  if (message?.phase !== "credentials-ready") return;
  clearTimeout(timer);
  // The child also bounds each Electron launch. This bounds the entire run,
  // including native credential cleanup after all measurements.
  timer = setTimeout(() => stop("MISSION_BENCHMARK_RUN_TIMEOUT"), 4 * 60 * 60 * 1000);
});
child.on("error", (error) => {
  clearTimeout(timer);
  process.stderr.write(`MISSION_BENCHMARK_START_FAILED: ${error.message}\n`);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  clearTimeout(timer);
  if (killTimer) clearTimeout(killTimer);
  process.exitCode = failure ? 1 : (code ?? 1);
});
