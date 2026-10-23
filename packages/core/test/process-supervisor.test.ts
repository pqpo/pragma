import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  BoundedRuntimeOutputBuffer,
  RuntimeProcessSupervisor,
} from "../src/runtime/process-supervisor.ts";

describe("RuntimeProcessSupervisor", () => {
  it("preserves a failed spawn error while allowing resource cleanup without an exit event", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-spawn-failure-"));
    try {
      const child = spawn(join(root, "missing-executable"), [], { stdio: "pipe" });
      const supervisor = new RuntimeProcessSupervisor(child);
      await expect(supervisor.exit).rejects.toMatchObject({ code: "ENOENT" });
      expect(supervisor.hasExited()).toBe(true);
      await expect(supervisor.terminate()).resolves.toBeUndefined();
      child.stdin.destroy();
      child.stdout.destroy();
      child.stderr.destroy();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("does not treat an error from a running process as confirmed exit", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
      stdio: "pipe",
    });
    const supervisor = new RuntimeProcessSupervisor(child);
    try {
      await once(child, "spawn");
      expect(child.pid).toBeDefined();
      const error = new Error("Runtime process transport error");
      const rejected = expect(supervisor.exit).rejects.toBe(error);
      child.emit("error", error);
      await rejected;
      expect(supervisor.hasExited()).toBe(false);
      const exited = once(child, "exit");
      child.kill("SIGTERM");
      await exited;
      expect(supervisor.hasExited()).toBe(true);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("terminates a provider process and makes repeated termination idempotent", async () => {
    const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], {
      stdio: "pipe",
    });
    const supervisor = new RuntimeProcessSupervisor(child);

    const first = supervisor.terminate({ graceMs: 500 });
    const second = supervisor.terminate({ graceMs: 500 });

    expect(first).toBe(second);
    await first;
    await expect(supervisor.exit).resolves.toMatchObject({ signal: "SIGTERM" });
    expect(supervisor.hasExited()).toBe(true);
  });
});

describe("BoundedRuntimeOutputBuffer", () => {
  it("retains only the configured head or tail bytes", () => {
    const head = new BoundedRuntimeOutputBuffer(4, "head");
    const tail = new BoundedRuntimeOutputBuffer(4, "tail");

    head.append("abcdef");
    tail.append("abcdef");

    expect(head.text()).toBe("abcd");
    expect(tail.text()).toBe("cdef");
    expect(head.byteLength).toBe(4);
    expect(tail.byteLength).toBe(4);
  });
});
