import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  updateRuntimeSessionRecord,
  type PragmaPaths,
  type RuntimeSessionRecord,
} from "@pragma/core";

const execute = promisify(execFile);

/** These adapters always pass a private Runtime directory to their child process. */
const isolatedProcessKinds = new Set([
  "codex-local",
  "claude-code-local",
  "qodercli-local",
  "opencode-local",
  "antigravity-local",
]);

/** Never infer process death from a terminal Mission, age, or absence from Host memory. */
export async function confirmHistoricalRuntimeStops(
  paths: PragmaPaths,
  records: readonly RuntimeSessionRecord[],
): Promise<readonly RuntimeSessionRecord[]> {
  const pending = records.filter((record) => record.processState !== "stopped");
  if (pending.length === 0) return [];
  // Windows CIM command lines do not expose the private environment. Absence from
  // that inventory cannot prove that a Runtime process has stopped.
  if ((process.platform !== "darwin" && process.platform !== "linux") || !process.getuid)
    return pending;
  let snapshot: string;
  try {
    // Read only the current user's processes, including untruncated environments.
    // Do not log this snapshot: provider environments may contain credentials.
    const { stdout } = await execute(
      "ps",
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
    );
    snapshot = stdout;
    // A failed/empty/partial listing is not evidence of process death.
    if (
      !snapshot.includes("PRAGMA_RUNTIME_STOP_INSPECTION=1") ||
      !snapshot.split("\n").some((line) => Number(line.trim().split(/\s+/, 1)[0]) === process.pid)
    )
      return pending;
  } catch {
    return pending;
  }
  const unconfirmed: RuntimeSessionRecord[] = [];
  for (const record of pending) {
    const directory = paths.ownedSystemSessionRoot(record.owner.ownerId, record.systemSessionId);
    if (
      !isolatedProcessKinds.has(record.runtime.kind) ||
      [...directory].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      snapshot.includes(directory)
    ) {
      unconfirmed.push(record);
      continue;
    }
    await updateRuntimeSessionRecord(paths, record, { processState: "stopped" });
  }
  return unconfirmed;
}
