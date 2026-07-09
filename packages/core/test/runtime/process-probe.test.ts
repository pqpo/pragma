import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";

import { describe, expect, it } from "vitest";

import { canUseRuntimeBinary, type RuntimeCommandSpawn } from "../../src/runtime/process-probe.ts";

describe("canUseRuntimeBinary", () => {
  it("reports a usable runtime with executable and version details", async () => {
    const process = new FakeProbeProcess({
      exitCode: 0,
      stdout: "tool 1.2.3\n",
    });

    const result = await canUseRuntimeBinary({
      runtimeName: "Tool CLI",
      defaultExecutablePath: "tool",
      spawn: process.spawn,
    });

    expect(result).toEqual({
      usable: true,
      details: {
        executablePath: "tool",
        version: "tool 1.2.3",
      },
    });
    expect(process.command).toBe("tool");
    expect(process.args).toEqual(["--version"]);
  });

  it("reports a failed runtime probe with process details", async () => {
    const process = new FakeProbeProcess({
      exitCode: 2,
      stderr: "not logged in\n",
    });

    const result = await canUseRuntimeBinary({
      runtimeName: "Tool CLI",
      defaultExecutablePath: "tool",
      executablePath: "/bin/tool",
      spawn: process.spawn,
    });

    expect(result).toEqual({
      usable: false,
      reason: "Tool CLI probe failed with exit code 2.",
      details: {
        executablePath: "/bin/tool",
        exitCode: 2,
        signal: null,
        stderr: "not logged in\n",
      },
    });
  });

  it("reports spawn errors as unavailable runtimes", async () => {
    const process = new FakeProbeProcess({
      error: new Error("ENOENT"),
    });

    const result = await canUseRuntimeBinary({
      runtimeName: "Tool CLI",
      defaultExecutablePath: "tool",
      spawn: process.spawn,
    });

    expect(result).toEqual({
      usable: false,
      reason: 'Tool CLI is not available at "tool": ENOENT',
      details: {
        executablePath: "tool",
      },
    });
  });

  it("keeps the first output line when probe output exceeds the capture limit", async () => {
    const process = new FakeProbeProcess({
      exitCode: 0,
      stdout: `tool 1.2.3\n${"x".repeat(9_000)}`,
    });

    const result = await canUseRuntimeBinary({
      runtimeName: "Tool CLI",
      defaultExecutablePath: "tool",
      spawn: process.spawn,
    });

    expect(result.details).toEqual({
      executablePath: "tool",
      version: "tool 1.2.3",
    });
  });
});

class FakeProbeProcess extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly stdin = new Writable({
    write(_chunk, _encoding, callback) {
      callback();
    },
  });
  command = "";
  args: readonly string[] = [];

  readonly spawn: RuntimeCommandSpawn = (command, args) => {
    this.command = command;
    this.args = args;
    queueMicrotask(() => {
      if (this.result.error !== undefined) {
        this.emit("error", this.result.error);
        return;
      }

      this.stdout.write(this.result.stdout ?? "");
      this.stderr.write(this.result.stderr ?? "");
      this.stdout.end();
      this.stderr.end();
      this.emit("exit", this.result.exitCode ?? 0, null);
    });
    return this as unknown as ChildProcessWithoutNullStreams;
  };

  constructor(
    private readonly result: {
      readonly exitCode?: number | undefined;
      readonly stdout?: string | undefined;
      readonly stderr?: string | undefined;
      readonly error?: Error | undefined;
    },
  ) {
    super();
  }

  kill(): boolean {
    this.emit("exit", null, "SIGTERM");
    return true;
  }
}
