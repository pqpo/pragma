/**
 * Desktop resource composition facade. The Local Host execution service owns
 * Run, Session, recovery, queue continuation and persistent Mission semantics.
 * Internal callers retain this thin export until the R4 entry-point migration.
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
