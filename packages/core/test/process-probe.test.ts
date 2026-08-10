import { describe, expect, it } from "vitest";

import { runRuntimeCommand } from "../src/runtime/process-probe.ts";

describe("Runtime process probe", () => {
  it("closes stdin so non-interactive commands waiting for EOF can start", async () => {
    const result = await runRuntimeCommand({
      executablePath: process.execPath,
      args: [
        "-e",
        'process.stdin.once("end", () => process.stdout.write("ready\\n")); process.stdin.resume();',
      ],
      cwd: process.cwd(),
      env: { ...process.env },
      timeoutMs: 2_000,
    });

    expect(result).toMatchObject({
      exitCode: 0,
      signal: null,
      stdout: "ready\n",
      stderr: "",
    });
  });
});
