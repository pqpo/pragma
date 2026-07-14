import { randomUUID } from "node:crypto";

import type { AgentInstance, Invocation } from "@pragma/shared";

import type { ExecutionAgentPatch, ExecutionStore, NewExecutionEvent } from "./execution-store.ts";

export class InvocationService {
  constructor(
    private readonly executionId: string,
    private readonly store: ExecutionStore,
  ) {}

  async ensureQueued(request: {
    readonly invocation: Invocation;
    readonly commitId?: string | undefined;
    readonly expectedVersion?: number | undefined;
    readonly agentPuts?: readonly AgentInstance[] | undefined;
    readonly agentPatches?: readonly ExecutionAgentPatch[] | undefined;
    readonly queuedData?: unknown;
    readonly events?: readonly NewExecutionEvent[] | undefined;
  }): Promise<void> {
    if (request.invocation.status !== "queued") {
      throw new Error("InvocationService.ensureQueued requires a queued Invocation.");
    }
    const existing = await this.store.getInvocation(
      this.executionId,
      request.invocation.invocationId,
    );
    if (existing !== undefined) return;
    await this.store.commit({
      commitId: request.commitId ?? `invocation-queued:${request.invocation.invocationId}`,
      executionId: this.executionId,
      expectedVersion: request.expectedVersion,
      invocationPuts: [request.invocation],
      agentPuts: request.agentPuts,
      agentPatches: request.agentPatches,
      events: [
        ...(request.events ?? []),
        {
          invocationId: request.invocation.invocationId,
          type: "invocation.queued",
          data: request.queuedData ?? {},
        },
      ],
    });
  }

  async transition(request: {
    readonly invocationId: string;
    readonly status: Invocation["status"];
    readonly patch?: Omit<Partial<Invocation>, "invocationId" | "status"> | undefined;
    readonly data?: unknown;
    readonly commitId?: string | undefined;
    readonly agentPatches?: readonly ExecutionAgentPatch[] | undefined;
    readonly events?: readonly NewExecutionEvent[] | undefined;
  }): Promise<void> {
    await this.store.commit({
      commitId: request.commitId ?? randomUUID(),
      executionId: this.executionId,
      invocationPatches: [
        {
          invocationId: request.invocationId,
          patch: { ...request.patch, status: request.status },
        },
      ],
      agentPatches: request.agentPatches,
      events: [
        {
          invocationId: request.invocationId,
          type: `invocation.${request.status}`,
          data: request.data ?? {},
        },
        ...(request.events ?? []),
      ],
    });
  }
}
