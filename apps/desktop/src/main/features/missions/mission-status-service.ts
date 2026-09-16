import type { MissionSurfaceAudience } from "./mission-runner-contracts.ts";

export interface MissionStatusNotification {
  readonly audience: MissionSurfaceAudience;
  readonly missionId: string;
  readonly execution?:
    | {
        readonly id: string;
        readonly status: "queued" | "running" | "waiting" | "succeeded" | "failed" | "cancelled";
      }
    | undefined;
}

/**
 * Dedicated transport for Mission metadata/status changes.
 *
 * Chat and work notifications describe their own projections and must never be
 * used as a proxy for Mission status changes.
 */
export class MissionStatusService {
  readonly #listeners = new Set<(notification: MissionStatusNotification) => void>();

  constructor(
    private readonly onListenerError: (input: {
      readonly error: unknown;
      readonly missionId: string;
    }) => void,
  ) {}

  publish(
    missionId: string,
    audience: MissionSurfaceAudience = "user",
    execution?: MissionStatusNotification["execution"],
  ): void {
    for (const listener of this.#listeners) {
      try {
        listener({
          audience,
          missionId,
          ...(execution === undefined ? {} : { execution }),
        });
      } catch (error) {
        this.onListenerError({ error, missionId });
      }
    }
  }

  subscribe(listener: (notification: MissionStatusNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
