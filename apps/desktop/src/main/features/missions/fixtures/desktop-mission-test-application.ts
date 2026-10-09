import { createLocalHostMissionExecutionService } from "@pragma/local-host";
import {
  createDesktopMissionExecutionResources,
  type DesktopMissionExecutionResourceOptions,
} from "../desktop-mission-execution-resources.ts";

/** Resource adapter integration harness; production composition uses the shared application factory. */
export function createDesktopMissionTestApplication(
  options: DesktopMissionExecutionResourceOptions,
) {
  return createLocalHostMissionExecutionService(createDesktopMissionExecutionResources(options));
}
export type DesktopMissionTestApplication = ReturnType<typeof createDesktopMissionTestApplication>;
export {
  activeMissionKnowledgeDraftNamespace,
  missionKnowledgeNamespace,
} from "../desktop-mission-execution-resources.ts";
export { readMissionConversationSnapshot } from "@pragma/local-host";
