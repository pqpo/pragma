import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { CodexAppServerClient } from "../src/app-server-client.ts";

describe("CodexAppServerClient", () => {
  it("terminates a spawned process when initialization fails", async () => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);

    const start = CodexAppServerClient.start({
      executablePath: "codex",
      args: ["app-server"],
      cwd: process.cwd(),
      env: {},
      clientInfo: { name: "test", title: "Test", version: "0.0.0" },
      spawn: () => {
        queueMicrotask(() => {
          child.emit("error", new Error("initialization failed"));
        });
        return child as unknown as ChildProcessWithoutNullStreams;
      },
    });

    await expect(start).rejects.toThrow("initialization failed");
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
