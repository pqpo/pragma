import type { ExpertSessionStore } from "@pragma/core";
import type { PromptRequest } from "@pragma/shared";

export interface PromptQueueProjectionItem {
  readonly position: number;
  readonly requestId: string;
  readonly executionId: string;
  readonly status: "queued" | "running";
  readonly content: string;
  readonly hasAttachments: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly steerable: boolean;
}

export interface PromptQueueProjection {
  readonly missionId: string;
  readonly sessionId?: string | undefined;
  readonly state: "idle" | "running" | "paused";
  readonly pendingCount: number;
  readonly pausedAfterRequestId?: string | undefined;
  readonly supportsSteer: boolean;
  readonly items: readonly PromptQueueProjectionItem[];
}

export interface PromptQueueProjectionPort {
  readonly list: (missionId: string) => Promise<PromptQueueProjection>;
}

/**
 * Read-only projection of the Core ExpertSession prompt queue. It never reads
 * Local Host command operations, so Inbox operations and prompt queue items
 * cannot be confused at the application boundary.
 */
export function createExpertSessionPromptQueueProjection(options: {
  readonly sessions: Pick<ExpertSessionStore, "get" | "listPrompts" | "listEvents">;
  readonly resolveSessionId: (missionId: string) => Promise<string | undefined>;
  readonly supportsSteer?: ((sessionId: string) => Promise<boolean> | boolean) | undefined;
  readonly resolvePromptMetadata?:
    ((prompt: PromptRequest) => Promise<{ readonly hasAttachments: boolean }>) | undefined;
}): PromptQueueProjectionPort {
  return {
    async list(missionId) {
      const sessionId = await options.resolveSessionId(missionId);
      if (sessionId === undefined) return idleQueue(missionId);
      const session = await options.sessions.get(sessionId);
      if (session === undefined) return idleQueue(missionId, sessionId);
      const [prompts, events] = await Promise.all([
        options.sessions.listPrompts(sessionId),
        options.sessions.listEvents(sessionId),
      ]);
      const pending = prompts.filter(
        (prompt) =>
          prompt.mode === "enqueue" && (prompt.status === "queued" || prompt.status === "running"),
      );
      const lastControl = [...events]
        .toReversed()
        .find((event) =>
          ["prompt.queue-paused", "prompt.queue-resumed", "prompt.queue-cleared"].includes(
            event.type,
          ),
        );
      const paused =
        lastControl?.type === "prompt.queue-paused" &&
        pending.some((prompt) => prompt.status === "queued");
      const pausedAfterRequestId =
        paused && isRecord(lastControl?.data) && typeof lastControl.data.requestId === "string"
          ? lastControl.data.requestId
          : undefined;
      const supportsSteer =
        options.supportsSteer === undefined ? false : await options.supportsSteer(sessionId);
      const items = await Promise.all(
        prompts
          .filter(
            (prompt) =>
              prompt.mode === "enqueue" &&
              (prompt.status === "queued" || prompt.status === "running"),
          )
          .map(async (prompt, index) => {
            const metadata = await options.resolvePromptMetadata?.(prompt);
            const hasAttachments = metadata?.hasAttachments ?? false;
            return {
              position: index + 1,
              requestId: prompt.requestId,
              executionId: prompt.executionId,
              status: prompt.status === "running" ? ("running" as const) : ("queued" as const),
              content: prompt.content,
              hasAttachments,
              createdAt: prompt.createdAt,
              updatedAt: prompt.updatedAt,
              // Only a queued item can be promoted to the active turn.  A
              // running item is the active turn itself and is therefore not a
              // queue.steer target.
              steerable: prompt.status === "queued" && supportsSteer && !hasAttachments,
            };
          }),
      );
      return {
        missionId,
        sessionId,
        state:
          paused || session.activeExecutionId !== undefined || pending.length > 0
            ? paused
              ? "paused"
              : "running"
            : "idle",
        pendingCount: pending.length,
        ...(pausedAfterRequestId === undefined ? {} : { pausedAfterRequestId }),
        supportsSteer,
        items,
      };
    },
  };
}

function idleQueue(missionId: string, sessionId?: string): PromptQueueProjection {
  return {
    missionId,
    ...(sessionId === undefined ? {} : { sessionId }),
    state: "idle",
    pendingCount: 0,
    supportsSteer: false,
    items: [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
