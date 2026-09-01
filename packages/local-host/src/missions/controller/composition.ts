import type { MissionControllerGuard, MissionControllerStore } from "./mission-controller-store.ts";
import { createMissionControllerStore } from "./mission-controller-store.ts";
import { createMissionOwnerScope, type MissionOwnerScope } from "./owner-scope.ts";
import { createMissionQuery, type MissionQueryPort } from "../query.ts";
import { createMissionWatchApplication, type MissionWatchPort } from "./watch.ts";

/**
 * Shared Local Host Mission lifecycle composition.
 *
 * Controller persistence, the read-only query projection, the event watcher,
 * and owner lease/poller lifecycle form one boundary. Desktop and CLI may
 * provide different observability or semantic-write hooks, but neither app
 * should construct a second partial lifecycle by hand.
 */
export interface LocalHostMissionControllerComposition {
  readonly controller: MissionControllerStore;
  readonly query: MissionQueryPort;
  readonly watch: MissionWatchPort;
  readonly ownerScope: MissionOwnerScope;
}

export interface LocalHostMissionControllerCompositionOptions {
  readonly missionsPath: string;
  readonly onLeaseLost?: ((missionId: string) => Promise<void> | void) | undefined;
  readonly onPollingError?:
    | ((input: {
        readonly missionId: string;
        readonly error: unknown;
        readonly consecutiveFailures: number;
      }) => Promise<void> | void)
    | undefined;
  readonly recoverSemanticWrite?:
    | ((input: {
        readonly missionId: string;
        readonly guard: MissionControllerGuard;
      }) => Promise<void>)
    | undefined;
  readonly leaseMs?: number | undefined;
}

export function createLocalHostMissionController(
  options: LocalHostMissionControllerCompositionOptions,
): LocalHostMissionControllerComposition {
  const controller = createMissionControllerStore({ missionsPath: options.missionsPath });
  const ownerScope = createMissionOwnerScope({
    controller,
    leaseMs: options.leaseMs,
    onLeaseLost: options.onLeaseLost,
    onPollingError: options.onPollingError,
    recoverSemanticWrite: options.recoverSemanticWrite,
  });
  return {
    controller,
    ownerScope,
    query: createMissionQuery({ controller }),
    watch: createMissionWatchApplication({ controller }),
  };
}
