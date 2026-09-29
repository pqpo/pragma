import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import type { CodexRuntimeSpawn } from "../src/types.ts";

export interface AppServerRequest {
  readonly id: number;
  readonly method: string;
  readonly params: Record<string, unknown>;
}

/** A controllable stdio peer; Runtime and Core still use their real RPC and queue paths. */
export function createAppServerFixture() {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const requests: AppServerRequest[] = [];
  const write = (message: unknown): void => {
    stdout.write(`${JSON.stringify(message)}\n`);
  };
  const reply = (id: number, result: unknown): void => write({ id, result });
  const reject = (id: number, error: unknown): void => write({ id, error });
  const disconnect = (): void => {
    stdout.end();
    stderr.end();
  };
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      disconnect();
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  createInterface({ input: stdin }).on("line", (line) => {
    const request = JSON.parse(line) as AppServerRequest;
    if (request.id === undefined) return;
    requests.push(request);
    if (request.method === "initialize") reply(request.id, {});
    if (request.method === "thread/start") reply(request.id, { thread: { id: "thread-1" } });
    if (request.method === "turn/start") {
      const turnId = `turn-${requests.filter((item) => item.method === "turn/start").length}`;
      reply(request.id, { turn: { id: turnId } });
    }
    if (request.method === "turn/interrupt") {
      reply(request.id, {});
      const turnId = `turn-${requests.filter((item) => item.method === "turn/start").length}`;
      completeTurn(turnId, "interrupted");
    }
  });
  const completeTurn = (turnId: string, output: string): void => {
    write({
      method: "item/agentMessage/delta",
      params: { threadId: "thread-1", turnId, itemId: `message-${turnId}`, delta: output },
    });
    write({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } },
    });
  };
  const spawn: CodexRuntimeSpawn = () => child as ChildProcessWithoutNullStreams;
  return { spawn, requests, reply, reject, disconnect, completeTurn };
}
