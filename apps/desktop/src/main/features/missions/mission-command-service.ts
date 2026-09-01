import type { MissionCommandOutcomeNotification } from "./mission-runner-contracts.ts";

export class MissionCommandService {
  readonly #listeners = new Set<(notification: MissionCommandOutcomeNotification) => void>();

  constructor(
    private readonly onListenerError: (input: {
      readonly error: unknown;
      readonly notification: MissionCommandOutcomeNotification;
    }) => void,
  ) {}

  emit(notification: MissionCommandOutcomeNotification): void {
    for (const listener of this.#listeners) {
      try {
        listener(notification);
      } catch (error) {
        this.onListenerError({ error, notification });
      }
    }
  }

  subscribe(listener: (notification: MissionCommandOutcomeNotification) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }
}
