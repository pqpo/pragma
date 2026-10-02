import {
  createHostUsageStore,
  type HostUsageStore,
  type UsageObservationContext,
} from "@pragma/local-host";
export type DesktopUsageStore = HostUsageStore;
export type { UsageObservationContext };
export const createDesktopUsageStore = createHostUsageStore;

export class DesktopUsageUnavailableError extends Error {
  readonly code = "desktop_usage_unavailable";
  constructor(options?: ErrorOptions) {
    super(
      "Desktop usage data is unavailable. The original usage database was not modified.",
      options,
    );
    this.name = "DesktopUsageUnavailableError";
  }
}
export function createUnavailableDesktopUsageStore(input: {
  cause: unknown;
  now?: Date | undefined;
}): DesktopUsageStore {
  const unavailable = async (): Promise<never> => {
    throw new DesktopUsageUnavailableError({ cause: input.cause });
  };
  return {
    trackingStartedAt: (input.now ?? new Date()).toISOString(),
    record: unavailable,
    recordRecovered: unavailable,
    getOverview: unavailable,
    listSubjects: unavailable,
    getMissionUsage: unavailable,
    markSubjectDeleted: unavailable,
    assertAvailable: unavailable,
    reconcileActiveSubjects: unavailable,
    subscribe: () => () => undefined,
    start: unavailable,
    close: async () => undefined,
  };
}
