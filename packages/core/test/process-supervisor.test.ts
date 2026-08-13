import { spawn } from "node:child_process";

import { describe, expect, it } from "vitest";

import {
  BoundedRuntimeOutputBuffer,
  RuntimeProcessSupervisor,
} from "../src/runtime/process-supervisor.ts";

describe("RuntimeProcessSupervisor", () => {
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
