import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { RuntimeHostProcess } from "../storage/migrations/runtime-session/index.ts";

const execute = promisify(execFile);
let identity: Promise<RuntimeHostProcess> | undefined;

/** One Host instance per isolate; a PID's OS birth token survives module reloads. */
export function currentRuntimeHostProcess(): Promise<RuntimeHostProcess> {
  return (identity ??= (async () => ({
    type: "host" as const,
    processId: process.pid,
    instanceId: randomUUID(),
    processStartToken: await readProcessStartToken(process.pid),
  }))());
}

export async function runtimeHostProcessStatus(
  host: Pick<RuntimeHostProcess, "processId" | "processStartToken">,
): Promise<"alive" | "dead" | "unknown"> {
  const status = processStatus(host.processId);
  if (status !== "alive") return status;
  if (host.processStartToken === null) return "alive";
  const current =
    host.processId === process.pid
      ? (await currentRuntimeHostProcess()).processStartToken
      : await readProcessStartToken(host.processId);
  if (current === null) return processStatus(host.processId) === "dead" ? "dead" : "unknown";
  return current === host.processStartToken ? "alive" : "dead";
}

function processStatus(pid: number): "alive" | "dead" | "unknown" {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    if (error instanceof Error && "code" in error) {
      if (error.code === "ESRCH") return "dead";
      if (error.code === "EPERM") return "unknown";
    }
    return "unknown";
  }
}

async function readProcessStartToken(pid: number): Promise<string | null> {
  try {
    if (process.platform === "linux") {
      const [boot, stat] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readFile(`/proc/${pid}/stat`, "utf8"),
      ]);
      const ticks = stat
        .slice(stat.lastIndexOf(")") + 2)
        .trim()
        .split(/\s+/)[19];
      if (ticks && /^\d+$/.test(ticks)) return `linux:${boot.trim()}:${ticks}`;
    } else if (process.platform === "darwin") {
      // lstart is a process birth time, not the Runtime record's wall-clock age.
      // Read no arguments or environment (which can contain provider secrets).
      const { stdout } = await execute("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
        timeout: 2_000,
        maxBuffer: 4_096,
        encoding: "utf8",
      });
      const start = stdout.trim().replace(/\s+/g, " ");
      if (/^[A-Za-z]{3} [A-Za-z]{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/.test(start))
        return `darwin:${start}`;
    }
  } catch {
    /* An unavailable inspector is uncertainty, never proof of exit. */
  }
  return null;
}
