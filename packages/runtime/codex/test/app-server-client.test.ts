import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";
import { SteerNotDispatchedError } from "@pragma/core";

import { CodexAppServerClient } from "../src/app-server-client.ts";
import { createAppServerFixture } from "./app-server-fixture.ts";

describe("CodexAppServerClient", () => {
  it.each([undefined, null, {}, { turnId: "" }, { turnId: "other-turn" }])(
    "does not confirm delivery from an invalid steer response: %j",
    async (result) => {
      const peer = createAppServerFixture();
      const client = await startClient(peer.spawn);
      try {
        const steer = client.steerTurn(steerRequest);
        const rejected = expect(steer).rejects.toThrow("unconfirmed turn id");
        peer.reply(peer.requests.at(-1)!.id, result);
        await rejected;
      } finally {
        client.close();
      }
    },
  );

  it("confirms delivery only for the expected native turn", async () => {
    const peer = createAppServerFixture();
    const client = await startClient(peer.spawn);
    try {
      const steer = client.steerTurn(steerRequest);
      peer.reply(peer.requests.at(-1)!.id, { turnId: steerRequest.expectedTurnId });
      await expect(steer).resolves.toBeUndefined();
    } finally {
      client.close();
    }
  });

  it.each([
    ["no active turn to steer", "no_active_turn"],
    ["expected active turn id `turn-1` but found `turn-2`", "target_changed"],
    ["cannot steer a review turn", "runtime_unsupported"],
    ["cannot steer a compact turn", "runtime_unsupported"],
  ])("classifies Codex NotSubmitted rejection: %s", async (message, reason) => {
    const peer = createAppServerFixture();
    const client = await startClient(peer.spawn);
    try {
      const steer = client.steerTurn(steerRequest);
      const assertion = expect(steer).rejects.toMatchObject({
        name: "SteerNotDispatchedError",
        reason,
        cause: { method: "turn/steer", code: -32600, rpcMessage: message },
      });
      peer.reject(peer.requests.at(-1)!.id, { code: -32600, message });
      await assertion;
    } finally {
      client.close();
    }
  });

  it.each([
    { code: -32603, message: "no active turn to steer" },
    { code: "-32600", message: "no active turn to steer" },
    { code: -32600, message: "unknown rejection: no active turn to steer" },
    { code: -32600, message: "input must not be empty" },
    { code: -32603, message: "failed to steer turn: transport lost", data: { retryable: true } },
  ])("keeps an unconfirmed RPC error uncertain: $message ($code)", async (error) => {
    const peer = createAppServerFixture();
    const client = await startClient(peer.spawn);
    try {
      const steer = client.steerTurn(steerRequest).catch((caught: unknown) => caught);
      peer.reject(peer.requests.at(-1)!.id, error);
      const caught = await steer;
      expect(caught).toBeInstanceOf(Error);
      expect(caught).not.toBeInstanceOf(SteerNotDispatchedError);
      expect(caught).toMatchObject({ method: "turn/steer", code: error.code });
    } finally {
      client.close();
    }
  });

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

const steerRequest = {
  threadId: "thread-1",
  expectedTurnId: "turn-1",
  requestId: "request-1",
  input: [{ type: "text" as const, text: "redirect", text_elements: [] as const }],
};

async function startClient(spawn: ReturnType<typeof createAppServerFixture>["spawn"]) {
  return await CodexAppServerClient.start({
    executablePath: "codex",
    args: ["app-server"],
    cwd: process.cwd(),
    env: {},
    clientInfo: { name: "test", title: "Test", version: "0.0.0" },
    spawn,
  });
}
