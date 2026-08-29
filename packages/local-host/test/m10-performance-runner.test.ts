import { mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const runner = join(import.meta.dirname, "fixtures", "m10-performance-runner.mjs");
const repositoryRoot = join(import.meta.dirname, "..", "..", "..");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("M10 performance harness", () => {
  it("measures Inbox durable latency with a separate owner and producer", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-m10-performance-test-"));
    roots.push(root);
    const evidenceFile = join(root, "inbox.json");
    const result = await invoke([
      "--mode",
      "inbox",
      "--rounds",
      "1",
      "--requests",
      "4",
      "--timeout-ms",
      "30000",
      "--evidence-file",
      evidenceFile,
    ]);

    expect(result.exitCode).toBe(0);
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8")) as {
      status: string;
      rounds: readonly {
        kind: string;
        requests: number;
        records: readonly { state: string; createdAt: string; updatedAt: string }[];
        failures: number;
        processes: readonly { process: { pid: number; exitCode: number; signal: string | null } }[];
      }[];
    };
    expect(evidence.status).toBe("passed");
    expect(evidence.rounds).toHaveLength(1);
    expect(evidence.rounds[0]).toMatchObject({ kind: "inbox", requests: 4, failures: 0 });
    expect(evidence.rounds[0]?.records).toHaveLength(4);
    expect(
      evidence.rounds[0]?.records.every(
        (record) => Date.parse(record.updatedAt) >= Date.parse(record.createdAt),
      ),
    ).toBe(true);
    expect(evidence.rounds[0]?.processes.every((item) => item.process.exitCode === 0)).toBe(true);
    expect(evidence.rounds[0]?.processes.every((item) => item.process.signal === null)).toBe(true);
  }, 60_000);

  it("warms a real watcher, records steady RSS, and detaches before SIGINT", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-m10-performance-test-"));
    roots.push(root);
    const evidenceFile = join(root, "watch.json");
    const result = await invoke([
      "--mode",
      "watch",
      "--rounds",
      "1",
      "--warmup-ms",
      "100",
      "--steady-ms",
      "500",
      "--sample-ms",
      "100",
      "--timeout-ms",
      "30000",
      "--evidence-file",
      evidenceFile,
    ]);

    expect(result.exitCode).toBe(0);
    const evidence = JSON.parse(await readFile(evidenceFile, "utf8")) as {
      status: string;
      rounds: readonly {
        kind: string;
        finalRssBytes: number;
        samples: readonly { rssBytes: number }[];
        steadyDurationMs: number;
        cpuPercent: number;
        storage: { changed: boolean };
        processes: readonly { process: { pid: number; exitCode: number; signal: string | null } }[];
      }[];
    };
    expect(evidence.status).toBe("passed");
    expect(evidence.rounds[0]).toMatchObject({ kind: "watch" });
    expect(evidence.rounds[0]?.samples.length).toBeGreaterThanOrEqual(2);
    expect(evidence.rounds[0]?.finalRssBytes).toBeGreaterThan(0);
    expect(evidence.rounds[0]?.steadyDurationMs).toBeGreaterThan(0);
    expect(evidence.rounds[0]?.cpuPercent).toBeGreaterThanOrEqual(0);
    expect(evidence.rounds[0]?.storage.changed).toBe(false);
    expect(evidence.rounds[0]?.processes.every((item) => item.process.pid > 0)).toBe(true);
    expect(evidence.rounds[0]?.processes.every((item) => item.process.exitCode === 0)).toBe(true);
    expect(evidence.rounds[0]?.processes.every((item) => item.process.signal === null)).toBe(true);
    expect(JSON.stringify(evidence)).not.toContain("M10_SECRET_CANARY");
  }, 60_000);
});

function invoke(arguments_: readonly string[]): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [runner, ...arguments_], {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr }));
  });
}

interface ProcessResult {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}
