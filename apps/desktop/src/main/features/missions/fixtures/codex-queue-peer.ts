import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";

import type { CodexRuntimeSpawn } from "@pragma/runtime-codex";

/** Controlled native peer; Codex Adapter, Core storage and Desktop observers remain real. */
export function createCodexQueuePeer(
  queries: readonly string[],
  onStart: (query: string, finish: () => void, append: (delta: string) => void) => void,
) {
  const child = new EventEmitter();
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let turnIndex = 0;
  const write = (value: unknown): void => {
    stdout.write(`${JSON.stringify(value)}\n`);
  };
  const finish = (turnId: string): void =>
    write({
      method: "turn/completed",
      params: { threadId: "thread-1", turn: { id: turnId, status: "completed" } },
    });
  Object.assign(child, {
    stdin,
    stdout,
    stderr,
    kill: () => {
      stdout.end();
      stderr.end();
      queueMicrotask(() => child.emit("exit", 0, null));
      return true;
    },
  });
  createInterface({ input: stdin }).on("line", (line) => {
    const request = JSON.parse(line) as { id?: number; method: string };
    if (request.id === undefined) return;
    if (request.method === "initialize") write({ id: request.id, result: {} });
    if (request.method === "thread/start")
      write({ id: request.id, result: { thread: { id: "thread-1" } } });
    if (request.method === "turn/start") {
      const query = queries[turnIndex];
      const turnId = `turn-${++turnIndex}`;
      if (query === undefined) throw new Error("Unexpected extra Codex turn");
      write({ id: request.id, result: { turn: { id: turnId } } });
      const append = (delta: string): void =>
        write({
          method: "item/agentMessage/delta",
          params: { threadId: "thread-1", turnId, itemId: `message-${turnId}`, delta },
        });
      append(`answer:${query}`);
      onStart(query, () => finish(turnId), append);
    }
    if (request.method === "turn/interrupt") {
      write({ id: request.id, result: {} });
      finish(`turn-${turnIndex}`);
    }
  });
  const spawn: CodexRuntimeSpawn = () => child as ChildProcessWithoutNullStreams;
  return { spawn };
}
