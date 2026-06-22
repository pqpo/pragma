import { describe, expect, it } from "vitest";

import { AsyncPushQueue } from "./async-push-queue.ts";

describe("AsyncPushQueue", () => {
  it("delivers values pushed before and after consumers wait", async () => {
    const queue = new AsyncPushQueue<number>();
    queue.push(1);

    const iterator = queue[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toEqual({ value: 1, done: false });

    const pending = iterator.next();
    queue.push(2);
    queue.close();

    await expect(pending).resolves.toEqual({ value: 2, done: false });
    await expect(iterator.next()).resolves.toEqual({ value: undefined, done: true });
  });

  it("rejects pending and future iteration when failed", async () => {
    const queue = new AsyncPushQueue<number>();
    const iterator = queue[Symbol.asyncIterator]();
    const pending = iterator.next();
    const error = new Error("queue failed");

    queue.fail(error);

    await expect(pending).rejects.toThrow(error);
    await expect(iterator.next()).rejects.toThrow(error);
  });

  it("does not lose synchronous callback bursts", async () => {
    const queue = new AsyncPushQueue<number>();

    for (let value = 0; value < 5; value++) {
      queue.push(value);
    }
    queue.close();

    const values: number[] = [];
    for await (const value of queue) {
      values.push(value);
    }

    expect(values).toEqual([0, 1, 2, 3, 4]);
  });
});
