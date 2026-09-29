import type {
  MissionChatEntry,
  MissionConversationSnapshot,
} from "../../../../shared/contracts/index.ts";

export const MISSION_STREAM_IDLE_MS = 1_000;

export function canShowMissionStreamWaiting(
  chat: MissionConversationSnapshot | null,
  active: boolean,
  waitingForUser: boolean,
  completed: boolean,
): boolean {
  return (
    active &&
    !waitingForUser &&
    !completed &&
    chat?.queue?.state !== "paused" &&
    (chat?.controlHealth === undefined ||
      ["idle", "healthy_active"].includes(chat.controlHealth.state))
  );
}

/** A refresh can recover output after invalidation or backpressure without entry patches. */
export function missionRefreshOutputCandidates(
  current: MissionConversationSnapshot | null,
  next: MissionConversationSnapshot,
): readonly MissionChatEntry[] {
  if (current === null || next.execution === undefined || next.revision < current.revision)
    return [];
  // Historical paging uses update(), not this stream commit path. Only output for
  // the currently selected execution may hide the indicator after a refresh.
  return next.entries.filter((entry) => entry.executionId === next.execution?.id);
}

/** Only committed, visible output counts as activity; snapshots and state polls do not. */
export function missionEntryOutputChanged(
  previous: MissionChatEntry | undefined,
  entry: MissionChatEntry,
): boolean {
  if (previous?.kind !== entry.kind) previous = undefined;
  switch (entry.kind) {
    case "assistant":
    case "thinking":
      return (
        entry.content.length > 0 &&
        (previous === undefined ||
          ((previous.kind === "assistant" || previous.kind === "thinking") &&
            entry.content !== previous.content))
      );
    case "tool":
      return (
        previous === undefined ||
        (previous.kind === "tool" &&
          (entry.toolName !== previous.toolName ||
            entry.status !== previous.status ||
            entry.inputPreview !== previous.inputPreview ||
            entry.outputPreview !== previous.outputPreview ||
            entry.error !== previous.error))
      );
    case "agent_activity":
      return (
        previous === undefined ||
        (previous.kind === "agent_activity" &&
          (entry.phase !== previous.phase ||
            entry.label !== previous.label ||
            entry.error !== previous.error))
      );
    default:
      return false;
  }
}

/** Publishes only visibility transitions, keeping token updates outside page React state. */
export class MissionStreamIdleStore {
  readonly #listeners = new Set<() => void>();
  #visible = false;
  #active = false;
  #executionId: string | undefined;
  #lastOutput: { executionId: string | undefined; at: number } | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;

  getSnapshot = (): boolean => this.#visible;
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  configure(active: boolean, executionId: string | undefined, immediate: boolean): void {
    if (active === this.#active && executionId === this.#executionId) return;
    const alreadyVisible = this.#active && this.#visible;
    this.#clearTimer();
    this.#active = active;
    this.#executionId = executionId;
    if (!active) {
      this.#setVisible(false);
      return;
    }
    const last = this.#lastOutput;
    if (last !== undefined && last.executionId === executionId) {
      const remaining = Math.max(0, MISSION_STREAM_IDLE_MS - (Date.now() - last.at));
      this.#setVisible(remaining === 0);
      if (remaining > 0) this.#schedule(remaining);
    } else {
      this.#setVisible(immediate || alreadyVisible);
      if (!immediate && !alreadyVisible) this.#schedule(MISSION_STREAM_IDLE_MS);
    }
  }

  output(executionId: string | undefined, activeExecutionId = this.#executionId): void {
    // The committed snapshot can advance before React configures the new execution.
    if (activeExecutionId !== undefined && executionId !== activeExecutionId) return;
    this.#lastOutput = { executionId, at: Date.now() };
    if (!this.#active || (this.#executionId !== undefined && executionId !== this.#executionId))
      return;
    this.#clearTimer();
    this.#setVisible(false);
    this.#schedule(MISSION_STREAM_IDLE_MS);
  }

  stop(): void {
    this.#clearTimer();
    this.#active = false;
    this.#setVisible(false);
  }

  #schedule(delay: number): void {
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      if (this.#active) this.#setVisible(true);
    }, delay);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }

  #setVisible(visible: boolean): void {
    if (visible === this.#visible) return;
    this.#visible = visible;
    for (const listener of this.#listeners) listener();
  }
}
