import type {
  MissionContextWindowSnapshot,
  MissionConversationState,
  PragmaDesktopAPI,
} from "../../../../shared/contracts/index.ts";

/** One read per kind; all callers await the dirty follow-up as well. */
export function createMissionRefresh(readOnce: () => Promise<void>, isClosed: () => boolean) {
  let active: Promise<void> | undefined;
  let dirty = false;
  return function refresh(): Promise<void> {
    if (isClosed()) return Promise.resolve();
    if (active !== undefined) {
      dirty = true;
      return active;
    }
    const pending = (async () => {
      do {
        dirty = false;
        await readOnce();
      } while (dirty && !isClosed());
    })().finally(() => {
      if (active === pending) active = undefined;
    });
    active = pending;
    return pending;
  };
}

/** Control and Context settle independently; refresh bursts retain one pending reread. */
export function createMissionBackgroundReads(input: {
  readonly api: Pick<PragmaDesktopAPI, "getMissionConversationState" | "getMissionContextWindow">;
  readonly missionId: string;
  readonly onControl: (value: MissionConversationState) => void;
  readonly onContext: (value: MissionContextWindowSnapshot) => void;
  readonly onControlError: (error: unknown) => void;
  readonly onContextError: (error: unknown) => void;
}) {
  let closed = false;
  const reader = <T>(
    load: () => Promise<T>,
    apply: (value: T) => void,
    fail: (error: unknown) => void,
  ) => {
    let reading = false;
    let dirty = false;
    const refresh = async (): Promise<void> => {
      if (closed) return;
      if (reading) {
        dirty = true;
        return;
      }
      reading = true;
      try {
        const value = await load();
        if (!closed) apply(value);
      } catch (error) {
        if (!closed) fail(error);
      } finally {
        reading = false;
        if (dirty && !closed) {
          dirty = false;
          void refresh();
        }
      }
    };
    return refresh;
  };
  return {
    refreshControl: reader(
      () => input.api.getMissionConversationState(input.missionId),
      input.onControl,
      input.onControlError,
    ),
    refreshContext: reader(
      () => input.api.getMissionContextWindow(input.missionId),
      input.onContext,
      input.onContextError,
    ),
    close: () => {
      closed = true;
    },
  };
}
