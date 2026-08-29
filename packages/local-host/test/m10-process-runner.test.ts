import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { M10ProcessEvidenceSchema } from "./m10-process-evidence.ts";

const roots: string[] = [];
const runner = join(import.meta.dirname, "fixtures", "m10-process-runner.mjs");
const repositoryRoot = join(import.meta.dirname, "..", "..", "..");

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("M10 process evidence runner", () => {
  it("runs a real Local Host child in isolated directories and cleans successful evidence", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "pragma-m10-evidence-"));
    roots.push(evidenceRoot);
    const evidenceFile = join(evidenceRoot, "success.json");
    const missionId = "00000000-0000-4000-8000-000000001001";
    const claimId = "00000000-0000-4000-8000-000000001002";
    const result = await invoke([
      "--scenario",
      "E01",
      "--target",
      "fixture",
      "--action",
      "claim",
      "--value",
      missionId,
      "--value",
      claimId,
      "--value",
      "1000",
      "--evidence-file",
      evidenceFile,
    ]);

    expect(result.exitCode).toBe(0);
    const evidence = M10ProcessEvidenceSchema.parse(
      JSON.parse(await readFile(evidenceFile, "utf8")),
    );
    expect(evidence.status).toBe("passed");
    expect(evidence.process.exitCode).toBe(0);
    expect(evidence.output.stdout).toContain("fencingToken");
    expect(evidence.isolation.cleanup).toBe("completed");
    await expect(access(evidence.isolation.root)).rejects.toMatchObject({ code: "ENOENT" });
    expect(new Set(Object.values(evidence.isolation).slice(0, 4)).size).toBe(4);
    expect(JSON.stringify(evidence)).not.toContain("M10_SECRET_CANARY");
  });

  it("redacts secrets and preserves the isolated root after a failed child", async () => {
    const evidenceRoot = await mkdtemp(join(tmpdir(), "pragma-m10-evidence-"));
    roots.push(evidenceRoot);
    const evidenceFile = join(evidenceRoot, "failure.json");
    const canary = "m10-secret-canary-20260828";
    const result = await invoke([
      "--scenario",
      "E15",
      "--target",
      "fixture",
      "--action",
      "fail",
      "--value",
      canary,
      "--redact",
      canary,
      "--evidence-file",
      evidenceFile,
    ]);

    expect(result.exitCode).toBe(1);
    const evidence = M10ProcessEvidenceSchema.parse(
      JSON.parse(await readFile(evidenceFile, "utf8")),
    );
    expect(evidence.status).toBe("failed");
    expect(evidence.process.exitCode).toBe(7);
    expect(evidence.isolation.cleanup).toBe("preserved");
    expect(evidence.output.stdout).toContain("[REDACTED]");
    expect(evidence.output.stderr).toContain("[REDACTED]");
    expect(JSON.stringify(evidence)).not.toContain(canary);
    await expect(access(evidence.isolation.root)).resolves.toBeUndefined();
    roots.push(evidence.isolation.root);
  });

  it("can run two independent scenarios without shared process state", async () => {
    const results = await Promise.all([
      invoke([
        "--scenario",
        "E02",
        "--target",
        "fixture",
        "--action",
        "claim",
        "--value",
        "00000000-0000-4000-8000-000000001011",
        "--value",
        "00000000-0000-4000-8000-000000001012",
        "--value",
        "1000",
      ]),
      invoke([
        "--scenario",
        "E03",
        "--target",
        "fixture",
        "--action",
        "claim",
        "--value",
        "00000000-0000-4000-8000-000000001021",
        "--value",
        "00000000-0000-4000-8000-000000001022",
        "--value",
        "1000",
      ]),
    ]);

    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    const evidence = results.map((result) => parseEvidenceFromStdout(result.stdout));
    expect(new Set(evidence.map((item) => item.isolation.root)).size).toBe(2);
    expect(evidence.every((item) => item.isolation.cleanup === "completed")).toBe(true);
  });
});

function parseEvidenceFromStdout(stdout: string) {
  return M10ProcessEvidenceSchema.parse(JSON.parse(stdout));
}

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
