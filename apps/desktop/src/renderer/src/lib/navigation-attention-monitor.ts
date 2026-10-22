import type { PragmaDesktopAPI } from "../../../shared/contracts/index.ts";
import { activeContextStoreRevisionTaskCount } from "../pages/studio/context-store-revision-model.ts";
import { activeSkillRevisionTaskCount } from "../pages/studio/SkillRevisionFragment.tsx";
import {
  missionNeedsAttention,
  emptyNavigationAttention,
  reconcileNavigationMissions,
  type NavigationAttention,
  type NavigationMissionEvent,
} from "./navigation-attention.ts";
import {
  missionUnreadOutputChangedEvent,
  readMissionOutputBoundaries,
  readUnreadMissionOutputIds,
  recordBackgroundMissionChatUpdate,
  writeMissionOutputBoundaries,
  writeUnreadMissionOutputIds,
} from "./mission-unread-output.ts";

type NavigationAPI = Pick<
  PragmaDesktopAPI,
  | "listMissions"
  | "listSkillRevisionJobs"
  | "listContextStoreRevisions"
  | "listMemoryExtractionJobs"
  | "subscribeMissionChatUpdates"
  | "subscribeMissionUpdates"
  | "subscribeMissionStatusUpdates"
>;

export function createNavigationAttentionMonitor(
  api: NavigationAPI,
  options: {
    readonly storage: Storage;
    readonly events: EventTarget;
    readonly missionsActive: () => boolean;
    readonly memoryEnabled: () => boolean;
    readonly onChange: (attention: NavigationAttention) => void;
  },
) {
  let disposed = false;
  let missions: ReturnType<typeof reconcileNavigationMissions> = [];
  let unreadIds = readUnreadMissionOutputIds(options.storage);
  let skills = false;
  let knowledge = false;
  let memory = false;
  let missionEvents: NavigationMissionEvent[] | undefined;
  const statusRevisions = new Map<string, number>();
  const removedMissionIds = new Set<string>();
  let lastAttention = emptyNavigationAttention;
  const publish = () => {
    if (!disposed) {
      const next: NavigationAttention = {
        missions: missions.some((mission) => missionNeedsAttention(mission, unreadIds)),
        studio: skills || knowledge,
        skills,
        knowledge,
        memory: options.memoryEnabled() && memory,
      };
      if (
        (Object.keys(next) as (keyof NavigationAttention)[]).every(
          (key) => next[key] === lastAttention[key],
        )
      )
        return;
      lastAttention = next;
      options.onChange(next);
    }
  };

  // Deduplicate each source separately so a slow endpoint cannot block every other badge.
  const refreshTask = <T>(load: () => Promise<T>, apply: (value: T) => void) => {
    let pending: Promise<void> | undefined;
    return () => {
      if (disposed) return Promise.resolve();
      pending ??= Promise.resolve()
        .then(async () => {
          if (disposed) return;
          const value = await load();
          if (!disposed) {
            apply(value);
            publish();
          }
        })
        .catch(() => {
          // Keep the last successful state until the next refresh.
        })
        .finally(() => {
          pending = undefined;
        });
      return pending;
    };
  };
  const refreshMissions = refreshTask(
    async () => {
      const events: NavigationMissionEvent[] = [];
      missionEvents = events;
      try {
        return { snapshot: await api.listMissions(), events };
      } catch (error) {
        missionEvents = undefined;
        throw error;
      }
    },
    ({ snapshot, events }) => {
      missions = reconcileNavigationMissions(snapshot, events).filter(
        (mission) => !removedMissionIds.has(mission.id),
      );
      missionEvents = undefined;
    },
  );
  const refreshSkills = refreshTask(
    () => api.listSkillRevisionJobs(),
    (entries) => {
      skills = activeSkillRevisionTaskCount(entries) > 0;
    },
  );
  const refreshKnowledge = refreshTask(
    () => api.listContextStoreRevisions(),
    (jobs) => {
      knowledge = activeContextStoreRevisionTaskCount(jobs) > 0;
    },
  );
  const refreshMemory = refreshTask(
    () =>
      api.listMemoryExtractionJobs({
        pages: {
          waiting: { pageIndex: 0 },
          attention: { pageIndex: 0 },
          running: { pageIndex: 0 },
          completed: { pageIndex: 0 },
        },
      }),
    (board) => {
      memory = board.lanes.attention.totalTasks > 0;
    },
  );
  const refresh = async () => {
    await Promise.all([
      refreshMissions(),
      refreshSkills(),
      refreshKnowledge(),
      ...(options.memoryEnabled() ? [refreshMemory()] : []),
    ]);
  };
  const syncUnread = (event: Event) => {
    unreadIds = [...(event as CustomEvent<readonly string[]>).detail];
    publish();
  };
  const onFocus = () => {
    void refresh();
  };
  options.events.addEventListener(missionUnreadOutputChangedEvent, syncUnread);
  options.events.addEventListener("focus", onFocus);
  const unsubscribeChat = api.subscribeMissionChatUpdates((update) => {
    // The mounted Missions page compares output against its conversation cache.
    if (disposed || options.missionsActive() || removedMissionIds.has(update.missionId)) return;
    recordBackgroundMissionChatUpdate(options.storage, update);
    unreadIds = readUnreadMissionOutputIds(options.storage);
    publish();
  });
  const applyMissionEvent = (event: NavigationMissionEvent) => {
    missionEvents?.push(event);
    missions = reconcileNavigationMissions(missions, [event]);
    publish();
  };
  const unsubscribeMissions = api.subscribeMissionUpdates((event) => {
    if (disposed) return;
    if (event.kind === "upsert" && removedMissionIds.has(event.mission.id)) return;
    if (event.kind === "remove") {
      removedMissionIds.add(event.missionId);
      const boundaries = { ...readMissionOutputBoundaries(options.storage) };
      delete boundaries[event.missionId];
      writeMissionOutputBoundaries(options.storage, boundaries);
      unreadIds = readUnreadMissionOutputIds(options.storage).filter(
        (id) => id !== event.missionId,
      );
      writeUnreadMissionOutputIds(options.storage, unreadIds);
      statusRevisions.delete(event.missionId);
    }
    applyMissionEvent(event);
  });
  const unsubscribeStatus = api.subscribeMissionStatusUpdates((event) => {
    if (disposed) return;
    if (removedMissionIds.has(event.missionId)) return;
    if ((statusRevisions.get(event.missionId) ?? 0) >= event.revision) return;
    statusRevisions.set(event.missionId, event.revision);
    applyMissionEvent(event);
  });
  const timer = setInterval(onFocus, 5_000);
  void refresh();
  return {
    refresh,
    dispose() {
      if (disposed) return;
      disposed = true;
      clearInterval(timer);
      options.events.removeEventListener("focus", onFocus);
      options.events.removeEventListener(missionUnreadOutputChangedEvent, syncUnread);
      unsubscribeChat();
      unsubscribeMissions();
      unsubscribeStatus();
    },
  };
}
