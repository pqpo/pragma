import {
  isLocalHostMissionExecutionService,
  type LocalHostMissionExecutionService,
} from "./execution-service.ts";
import type { LocalHostRunExecutorPort } from "../run.ts";

/** Resource resolution is injectable; execution always belongs to the shared service. */
export function createLocalHostMissionExecutionRunPort(
  service: LocalHostMissionExecutionService,
  resolve: LocalHostRunExecutorPort["resolve"],
): LocalHostRunExecutorPort {
  if (!isLocalHostMissionExecutionService(service))
    throw new Error(
      "Mission execution must be created by the Local Host execution service factory.",
    );
  return {
    resolve,
    validateInput: (input) => service.validateLocalHostRunInput?.(input) ?? Promise.resolve(),
    assertStartAllowed: (input) => service.assertLocalHostRunAllowed(input),
    start: (input) => service.startLocalHostRun(input),
  };
}
