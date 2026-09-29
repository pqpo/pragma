import { describe, expect, it, vi } from "vitest";
import type { OpenCode } from "@opencode/client";
import {
  SteerDeliveryUncertainError,
  SteerNotDispatchedError,
  type RuntimeSteerRequest,
} from "@pragma/core";
import { OpenCodeSteering, openCodeSteerMessageId } from "../src/steering.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const request: RuntimeSteerRequest = {
  requestId: "queued-message",
  targetRunId: "original-turn",
  attemptId: "attempt-1",
  content: "Follow this instruction",
};
function fixture() {
  const pending = new Map<
    string,
    { id: string; type: string; payload: { text: string; metadata?: unknown } }
  >();
  const messages = new Map<string, unknown>();
  const synthetic = vi.fn(
    async (input: { id: string; sessionID: string; text: string; metadata: unknown }) => {
      messages.set(input.id, {
        id: input.id,
        type: "synthetic",
        text: input.text,
        metadata: input.metadata,
      });
      return { id: input.id, sessionID: input.sessionID };
    },
  );
  const wait = vi.fn(async (): Promise<void> => undefined);
  const cancel = vi.fn(async (input: { inboxID: string }) => {
    pending.delete(input.inboxID);
  });
  const client = {
    session: {
      synthetic,
      wait,
      compact: vi.fn(),
      interrupt: vi.fn(),
      inbox: { list: vi.fn(async () => [...pending.values()]), cancel },
      message: {
        get: vi.fn(async (input: { messageID: string }) => {
          if (!messages.has(input.messageID)) {
            const error = new Error("Missing message");
            error.name = "MessageNotFoundError";
            throw error;
          }
          return messages.get(input.messageID);
        }),
      },
    },
  } as unknown as ReturnType<typeof OpenCode.make>;
  const stop = vi.fn(async () => undefined);
  return {
    steering: new OpenCodeSteering(client, stop),
    synthetic,
    wait,
    cancel,
    pending,
    messages,
    stop,
    client,
  };
}

describe("OpenCode steering lifecycle", () => {
  it("holds the original Pragma turn across a steer admitted after the first native wait", async () => {
    const f = fixture();
    const firstWait = deferred<void>();
    const admitted = deferred<void>();
    f.synthetic.mockImplementationOnce(async (input) => {
      await admitted.promise;
      return { id: input.id, sessionID: input.sessionID };
    });
    const turn = f.steering.begin("native", request.targetRunId, new AbortController().signal);
    turn.ready = true;
    f.wait.mockImplementationOnce(async () => await firstWait.promise);
    const settlement = f.steering.settle(turn, f.wait);
    await vi.waitFor(() => expect(f.wait).toHaveBeenCalledTimes(1));
    const delivery = f.steering.steer("native", request);
    firstWait.resolve();
    let completed = false;
    void settlement.then(() => {
      completed = true;
    });
    await vi.waitFor(() => expect(f.synthetic).toHaveBeenCalledTimes(1));
    expect(completed).toBe(false);
    expect(() => f.steering.begin("native", "next", new AbortController().signal)).toThrow(
      /active/,
    );
    admitted.resolve();
    await delivery;
    await settlement;
    expect(f.wait).toHaveBeenCalledTimes(2);
    expect(() => f.steering.steer("native", request)).toThrow(SteerNotDispatchedError);
    await f.steering.end(turn, false);
    f.steering.begin("native", "next", new AbortController().signal);
    expect(() => f.steering.steer("native", request)).toThrow(SteerNotDispatchedError);
    expect(f.synthetic).toHaveBeenCalledTimes(1);
  });

  it("rejects preparation and closed targets without native admission and deduplicates an active attempt", async () => {
    const f = fixture();
    const turn = f.steering.begin("native", request.targetRunId, new AbortController().signal);
    expect(() => f.steering.steer("native", request)).toThrow(SteerNotDispatchedError);
    turn.ready = true;
    const first = f.steering.steer("native", request);
    expect(f.steering.steer("native", request)).toBe(first);
    await first;
    await f.steering.settle(turn, f.wait);
    expect(() => f.steering.steer("native", request)).toThrow(SteerNotDispatchedError);
    expect(f.synthetic).toHaveBeenCalledTimes(1);
    expect(f.synthetic.mock.calls[0]?.[0]).toMatchObject({ delivery: "steer", resume: true });
  });

  it("stops the private server on a lost receipt and refuses a new turn", async () => {
    const f = fixture();
    f.synthetic.mockRejectedValueOnce(new Error("response lost"));
    const turn = f.steering.begin("native", request.targetRunId, new AbortController().signal);
    turn.ready = true;
    await expect(f.steering.steer("native", request)).rejects.toBeInstanceOf(
      SteerDeliveryUncertainError,
    );
    expect(f.stop).toHaveBeenCalledTimes(1);
    await f.steering.end(turn, true);
    expect(() => f.steering.begin("native", "next", new AbortController().signal)).toThrow(
      SteerDeliveryUncertainError,
    );
  });

  it("reconciles a restored receipt without resubmitting it", async () => {
    const f = fixture();
    const id = openCodeSteerMessageId("native", request);
    f.messages.set(id, {
      type: "synthetic",
      text: request.content,
      metadata: {
        "pragma.steering": {
          version: 1,
          attemptId: request.attemptId,
          targetRunId: request.targetRunId,
          requestId: request.requestId,
        },
      },
    });
    await expect(f.steering.reconcile("native", request)).resolves.toBe("delivered");
    expect(f.synthetic).not.toHaveBeenCalled();
    expect(openCodeSteerMessageId("native", { ...request, attemptId: "attempt-2" })).not.toBe(id);
  });

  it("distinguishes a canceled pending item from cancellation racing promotion", async () => {
    const f = fixture();
    const id = openCodeSteerMessageId("native", request);
    f.pending.set(id, {
      id,
      type: "synthetic",
      payload: {
        text: request.content,
        metadata: {
          "pragma.steering": {
            version: 1,
            attemptId: request.attemptId,
            targetRunId: request.targetRunId,
            requestId: request.requestId,
          },
        },
      },
    });
    await expect(f.steering.reconcile("native", request)).resolves.toBe("not_dispatched");
    expect(f.pending.size).toBe(0);
    f.pending.set(id, {
      id,
      type: "synthetic",
      payload: {
        text: request.content,
        metadata: {
          "pragma.steering": {
            version: 1,
            attemptId: request.attemptId,
            targetRunId: request.targetRunId,
            requestId: request.requestId,
          },
        },
      },
    });
    f.cancel.mockImplementationOnce(async () => {
      f.pending.delete(id);
      f.messages.set(id, {
        type: "synthetic",
        text: request.content,
        metadata: {
          "pragma.steering": {
            version: 1,
            attemptId: request.attemptId,
            targetRunId: request.targetRunId,
            requestId: request.requestId,
          },
        },
      });
    });
    await expect(f.steering.reconcile("native", request)).resolves.toBe("delivered");
    expect(f.synthetic).not.toHaveBeenCalled();
  });

  it("does not interpret reconciliation transport failure as non-delivery", async () => {
    const f = fixture();
    vi.mocked(f.client.session.message.get).mockRejectedValueOnce(new Error("connection reset"));
    await expect(f.steering.reconcile("native", request)).resolves.toBe("uncertain");
  });

  it("keeps an absent receipt uncertain because an orphaned server may still admit it", async () => {
    const f = fixture();
    await expect(f.steering.reconcile("native", request)).resolves.toBe("uncertain");
    expect(f.synthetic).not.toHaveBeenCalled();
  });

  it("rejects future steering markers rather than trusting a matching message ID", async () => {
    const f = fixture();
    f.messages.set(openCodeSteerMessageId("native", request), {
      type: "synthetic",
      text: request.content,
      metadata: { "pragma.steering": { version: 2, ...request } },
    });
    await expect(f.steering.reconcile("native", request)).resolves.toBe("uncertain");
  });

  it("waits for an in-flight admission before cancellation and removes pending work on failure", async () => {
    const f = fixture();
    const admitted = deferred<void>();
    const id = openCodeSteerMessageId("native", request);
    f.synthetic.mockImplementationOnce(async (input) => {
      await admitted.promise;
      f.pending.set(id, {
        id,
        type: "synthetic",
        payload: { text: input.text, metadata: input.metadata },
      });
      return { id: input.id, sessionID: input.sessionID };
    });
    const turn = f.steering.begin("native", request.targetRunId, new AbortController().signal);
    turn.ready = true;
    const delivery = f.steering.steer("native", request);
    const cancellation = f.steering.cancel("native");
    expect(f.client.session.interrupt).not.toHaveBeenCalled();
    admitted.resolve();
    await delivery;
    await cancellation;
    await f.steering.end(turn, true);
    expect(f.cancel).toHaveBeenCalledWith({ sessionID: "native", inboxID: id });
    expect(f.pending.size).toBe(0);
  });
});
