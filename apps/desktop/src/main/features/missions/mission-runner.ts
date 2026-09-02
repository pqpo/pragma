/**
 * Stable Mission Runner facade.
 *
 * Stateful domain ownership lives in the Session, Lifecycle, Command, Chat, and Work services.
 * The composition module wires those services to Desktop storage and Runtime adapters.
 */
export {
  activeMissionKnowledgeDraftNamespace,
  compactExpertSessionContext,
  consumeLiveChatOutput,
  createMissionRunner,
  isRootMissionRuntimeOutput,
  mergeMissionExecutorMetadata,
  missionKnowledgeDraftNamespace,
  missionKnowledgeNamespace,
  toDesktopHumanRequest,
  type LiveMissionChat,
  type MissionChatNotification,
  type MissionCommandOutcomeNotification,
  type MissionRunner,
  type MissionExecutorPresentationMetadata,
  type MissionSurfaceAudience,
  type MissionWorkNotification,
} from "./mission-runner-composition.ts";
