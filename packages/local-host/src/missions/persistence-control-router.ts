import type { LocalHostCoreMissionControlAdapter } from "../core-control-adapter.ts";

/** Select persistence adapters; both use the same command handlers and Session lifecycle. */
export function createMissionPersistenceControlRouter(
  fallback: LocalHostCoreMissionControlAdapter,
  resolve: (missionId: string) => Promise<LocalHostCoreMissionControlAdapter>,
  adapters: readonly LocalHostCoreMissionControlAdapter[],
): LocalHostCoreMissionControlAdapter {
  return {
    ...fallback,
    bindApplication: (application) => {
      for (const adapter of adapters) adapter.bindApplication(application);
    },
    consumer: {
      validateStrictTarget: async (input) =>
        await (await resolve(input.command.missionId)).consumer.validateStrictTarget?.(input),
      apply: async (input) => await (await resolve(input.command.missionId)).consumer.apply(input),
      afterOutcome: async (input) =>
        await (await resolve(input.command.missionId)).consumer.afterOutcome?.(input),
    },
    assertAcquisitionAllowed: async (id, purpose) =>
      await (await resolve(id)).assertAcquisitionAllowed(id, purpose),
    resolveStrictTarget: async (input) =>
      await (await resolve(input.missionId)).resolveStrictTarget(input),
    resolveExecutionTarget: async (input) =>
      await (await resolve(input.missionId)).resolveExecutionTarget(input),
    recoverMission: async (id) => await (await resolve(id)).recoverMission(id),
    release: async (id) => await (await resolve(id)).release(id),
    releaseAfterHumanCheckpoint: async (id, guard) =>
      await (await resolve(id)).releaseAfterHumanCheckpoint(id, guard),
    waitExecution: async (input) => await (await resolve(input.missionId)).waitExecution(input),
  };
}
