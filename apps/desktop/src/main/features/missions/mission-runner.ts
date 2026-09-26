/**
 * Stable Mission Runner facade.
 *
 * Stateful domain ownership lives in the Session, Lifecycle, Command, Chat, and Work services.
 * The composition module wires those services to Desktop storage and Runtime adapters.
 */
export {
  activeMissionKnowledgeDraftNamespace,
  compactExpertSessionContext,
  createMissionRunner,
  mergeMissionExecutorMetadata,
  missionKnowledgeDraftNamespace,
  missionKnowledgeNamespace,
  readMissionConversationSnapshot,
  toDesktopHumanRequest,
  type MissionChatNotification,
  type MissionCommandOutcomeNotification,
  type MissionRunner,
  type MissionExecutorPresentationMetadata,
  type MissionSurfaceAudience,
  type MissionWorkNotification,
} from "./mission-runner-composition.ts";
export {
  consumeLiveChatOutput,
  isRootMissionRuntimeOutput,
  type LiveMissionChat,
} from "./mission-chat-live.ts";
