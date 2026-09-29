import { z } from "zod";
import { createHash } from "node:crypto";
import type { OpenCode } from "@opencode/client";
import {
  SteerDeliveryUncertainError,
  SteerNotDispatchedError,
  type RuntimeSteerDelivery,
  type RuntimeSteerRequest,
} from "@pragma/core";

type Client = ReturnType<typeof OpenCode.make>;
const SteeringMarkerSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string().min(1),
    attemptId: z.string().min(1),
    targetRunId: z.string().min(1),
  })
  .strict();
function matchesMarker(value: unknown, request: RuntimeSteerRequest): boolean {
  const marker = SteeringMarkerSchema.safeParse(value);
  return (
    marker.success &&
    marker.data.requestId === request.requestId &&
    marker.data.targetRunId === request.targetRunId &&
    marker.data.attemptId === (request.attemptId ?? request.requestId)
  );
}
const requestOptions = () => ({ signal: AbortSignal.timeout(5_000) });
export interface OpenCodeSteeringTurn {
  readonly sessionId: string;
  readonly runId: string;
  readonly signal: AbortSignal;
  accepting: boolean;
  ready: boolean;
  revision: number;
  readonly deliveries: Map<string, Promise<void>>;
}

export function openCodeSteerMessageId(sessionId: string, request: RuntimeSteerRequest): string {
  return `msg_${createHash("sha256")
    .update(
      JSON.stringify([
        "pragma.steer/v1",
        sessionId,
        request.targetRunId,
        request.requestId,
        request.attemptId ?? request.requestId,
      ]),
    )
    .digest("hex")}`;
}

/** The private server belongs to one Runtime Context; no other client may submit work. */
export class OpenCodeSteering {
  private active: OpenCodeSteeringTurn | undefined;
  private poisoned = false;
  private stopped: Promise<void> | undefined;

  constructor(
    private readonly client: Client,
    private readonly stopProcess: () => Promise<void>,
  ) {}

  begin(sessionId: string, runId: string, signal: AbortSignal): OpenCodeSteeringTurn {
    if (this.poisoned || this.stopped !== undefined)
      throw new SteerDeliveryUncertainError(
        "OpenCode Session requires delivery reconciliation before another prompt.",
      );
    if (this.active !== undefined) throw new Error("OpenCode already has an active Pragma turn.");
    const turn = {
      sessionId,
      runId,
      signal,
      accepting: true,
      ready: false,
      revision: 0,
      deliveries: new Map<string, Promise<void>>(),
    };
    this.active = turn;
    return turn;
  }

  steer(sessionId: string, request: RuntimeSteerRequest): Promise<void> {
    const turn = this.active;
    if (this.poisoned)
      throw new SteerDeliveryUncertainError("OpenCode steer delivery requires reconciliation.");
    if (
      turn === undefined ||
      !turn.accepting ||
      !turn.ready ||
      turn.signal.aborted ||
      turn.sessionId !== sessionId ||
      turn.runId !== request.targetRunId
    ) {
      throw new SteerNotDispatchedError(
        "target_changed",
        "The target OpenCode turn is not accepting steering instructions.",
      );
    }
    const id = openCodeSteerMessageId(sessionId, request);
    const duplicate = turn.deliveries.get(id);
    if (duplicate !== undefined) return duplicate;
    turn.revision += 1;
    // Register before starting HTTP admission, so settlement cannot overtake this operation.
    const delivery = Promise.resolve().then(async () => {
      try {
        const receipt = await this.client.session.synthetic(
          {
            sessionID: sessionId,
            id,
            text: request.content,
            description: "Pragma steering instruction",
            metadata: {
              "pragma.steering": SteeringMarkerSchema.parse({
                version: 1,
                requestId: request.requestId,
                attemptId: request.attemptId ?? request.requestId,
                targetRunId: request.targetRunId,
              }),
            },
            delivery: "steer",
            resume: true,
          },
          { signal: AbortSignal.timeout(1_500) },
        );
        if (receipt.id !== id || receipt.sessionID !== sessionId)
          throw new Error("OpenCode returned a different steering receipt.");
      } catch (cause) {
        // Abort is not rollback: native admission is uninterruptible. Stop the owned process
        // before any later prompt, and leave Core's durable attempt uncertain for recovery.
        this.poisoned = true;
        turn.accepting = false;
        await this.stop().catch(() => undefined);
        throw new SteerDeliveryUncertainError(
          "OpenCode steering admission could not be confirmed.",
          { cause },
        );
      }
    });
    turn.deliveries.set(id, delivery);
    void delivery.catch(() => undefined);
    return delivery;
  }

  async settle(turn: OpenCodeSteeringTurn, wait: () => Promise<void>): Promise<void> {
    while (true) {
      const revision = turn.revision;
      await Promise.all(turn.deliveries.values());
      if (this.poisoned)
        throw new SteerDeliveryUncertainError(
          "OpenCode Session has an uncertain steering admission.",
        );
      await wait();
      // No await between the final revision check and closing admission.
      if (revision !== turn.revision) continue;
      turn.accepting = false;
      break;
    }
    const pending = await this.client.session.inbox.list(
      { sessionID: turn.sessionId },
      requestOptions(),
    );
    if (pending.some((item) => turn.deliveries.has(item.id))) {
      this.poisoned = true;
      await this.stop();
      throw new SteerDeliveryUncertainError(
        "OpenCode ended with an unconsumed steering instruction.",
      );
    }
  }

  async end(turn: OpenCodeSteeringTurn, failed: boolean): Promise<void> {
    turn.accepting = false;
    await Promise.allSettled(turn.deliveries.values());
    try {
      if (failed && !this.poisoned && this.stopped === undefined) {
        await this.client.session.interrupt(
          { sessionID: turn.sessionId, resume: false },
          { signal: AbortSignal.timeout(5_000) },
        );
        await this.client.session.wait(
          { sessionID: turn.sessionId },
          { signal: AbortSignal.timeout(5_000) },
        );
        const pending = await this.client.session.inbox.list(
          { sessionID: turn.sessionId },
          requestOptions(),
        );
        for (const item of pending) {
          if (turn.deliveries.has(item.id))
            await this.client.session.inbox.cancel({ sessionID: turn.sessionId, inboxID: item.id });
        }
        if (
          (
            await this.client.session.inbox.list({ sessionID: turn.sessionId }, requestOptions())
          ).some((item) => turn.deliveries.has(item.id))
        )
          throw new Error("OpenCode steering cleanup did not settle.");
      }
    } catch (cause) {
      this.poisoned = true;
      await this.stop();
      throw new SteerDeliveryUncertainError("OpenCode steering cleanup requires reconciliation.", {
        cause,
      });
    } finally {
      if (this.active === turn) this.active = undefined;
    }
  }

  async cancel(sessionId: string): Promise<void> {
    const turn = this.active;
    if (turn?.sessionId === sessionId) {
      turn.accepting = false;
      await Promise.allSettled(turn.deliveries.values());
    }
    if (this.stopped !== undefined) {
      await this.stopped;
      return;
    }
    await this.client.session.interrupt({ sessionID: sessionId, resume: false });
    await this.client.session.wait(
      { sessionID: sessionId },
      { signal: AbortSignal.timeout(5_000) },
    );
  }

  async reconcile(sessionId: string, request: RuntimeSteerRequest): Promise<RuntimeSteerDelivery> {
    if (this.active !== undefined || this.poisoned || this.stopped !== undefined)
      return "uncertain";
    const id = openCodeSteerMessageId(sessionId, request);
    // Remove a still-pending instruction; cancellation racing promotion is a no-op.
    // An absent message alone cannot prove non-delivery after a host crash: the
    // former private server may still be finishing an uninterruptible admission.
    const pending = await this.client.session.inbox.list(
      { sessionID: sessionId },
      requestOptions(),
    );
    const item = pending.find((entry) => entry.id === id);
    if (item !== undefined) {
      if (
        item.type !== "synthetic" ||
        item.payload.text !== request.content ||
        !matchesMarker(item.payload.metadata?.["pragma.steering"], request)
      )
        return "uncertain";
      await this.client.session.inbox.cancel(
        { sessionID: sessionId, inboxID: id },
        requestOptions(),
      );
    }
    await this.client.session.wait(
      { sessionID: sessionId },
      { signal: AbortSignal.timeout(5_000) },
    );
    if (
      (await this.client.session.inbox.list({ sessionID: sessionId }, requestOptions())).some(
        (entry) => entry.id === id,
      )
    )
      return "uncertain";
    try {
      const message = await this.client.session.message.get(
        {
          sessionID: sessionId,
          messageID: id,
        },
        requestOptions(),
      );
      if (message.type !== "synthetic" || message.text !== request.content) return "uncertain";
      if (!matchesMarker(message.metadata?.["pragma.steering"], request)) return "uncertain";
      return "delivered";
    } catch (error) {
      if (item !== undefined && error instanceof Error && error.name === "MessageNotFoundError")
        return "not_dispatched";
      return "uncertain";
    }
  }

  async compact(sessionId: string): Promise<void> {
    if (this.active !== undefined || this.poisoned || this.stopped !== undefined)
      throw new Error("OpenCode turn must settle before compaction.");
    await this.client.session.compact({ sessionID: sessionId });
    await this.client.session.wait({ sessionID: sessionId });
  }

  stop(): Promise<void> {
    if (this.active !== undefined) this.active.accepting = false;
    this.stopped ??= Promise.resolve().then(this.stopProcess);
    return this.stopped;
  }
}
