import { execFile } from "node:child_process";
import { rm } from "node:fs/promises";
import { sep } from "node:path";
import { promisify } from "node:util";
import type { PragmaPaths } from "@pragma/core";

const execute = promisify(execFile);

/** Best-effort orphan teardown after deletion commits; never gates user deletion. */
export async function stopHistoricalRuntimeProcesses(
  paths: PragmaPaths,
  ownerIds: readonly string[],
  signal: "SIGTERM" | "SIGKILL" = "SIGTERM",
): Promise<void> {
  if (ownerIds.length === 0) return;
  // Live Windows sessions are stopped by their adapter. Unix additionally lets
  // us identify orphan children by their private Runtime directory/environment.
  if ((process.platform !== "darwin" && process.platform !== "linux") || !process.getuid) return;
  const directories = [...new Set(ownerIds)].map((id) => paths.runtimeOwnerRoot(id) + sep);
  if (
    directories.some((directory) =>
      [...directory].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ),
    )
  )
    throw new Error("MISSION_DELETE_PROCESS_INSPECTION_UNAVAILABLE");
  // Never log this output: process environments may contain credentials.
  const { stdout } = await execute(
    process.platform === "darwin" ? "/bin/ps" : "ps",
    ["eww", "-U", String(process.getuid()), "-o", "pid=,command="],
    {
      timeout: 5_000,
      maxBuffer: 16 * 1024 * 1024,
      encoding: "utf8",
      env: {
        ...process.env,
        LC_ALL: process.platform === "darwin" ? "en_US.UTF-8" : "C.UTF-8",
        PRAGMA_RUNTIME_STOP_INSPECTION: "1",
      },
    },
  ).catch(() => {
    // execFile errors carry stdout; never forward the environment snapshot.
    throw new Error("MISSION_DELETE_PROCESS_INSPECTION_UNAVAILABLE");
  });
  const lines = stdout.split("\n");
  if (
    !stdout.includes("PRAGMA_RUNTIME_STOP_INSPECTION=1") ||
    !lines.some((line) => Number(line.trim().split(/\s+/, 1)[0]) === process.pid)
  )
    throw new Error("MISSION_DELETE_PROCESS_INSPECTION_UNAVAILABLE");
  let found = false;
  for (const line of lines) {
    const pid = Number(line.trim().split(/\s+/, 1)[0]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || pid === process.pid) continue;
    if (!directories.some((directory) => line.includes(directory))) continue;
    try {
      process.kill(pid, signal);
      found = true;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  // Reinspect on the worker's bounded retry; a sent signal is not an exit ack.
  if (found) throw new Error("MISSION_DELETE_PROCESS_CLEANUP_PENDING");
  // A child may have recreated its private directory after the owner move.
  // Owner fences already prohibit this graph from being restored or reused.
  await Promise.all(
    directories.map(async (directory) => await rm(directory, { recursive: true, force: true })),
  );
}
