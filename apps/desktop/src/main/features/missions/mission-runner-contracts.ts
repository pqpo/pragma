import type {
  AgentMessageUsage,
  ExpertPromptAttachment,
  HumanInteractionResponse,
} from "@pragma/shared";
import type { IntegrationError } from "@pragma/shared/integration";
import type {
  LocalHostRunEvent,
  LocalHostRunHandle,
  LocalHostRunRequest,
  MissionCommandConsumer,
  MissionControlTargetResolution,
  PromptQueueProjection,
  ResolvedRunExecutor,
} from "@pragma/local-host";

import type {
  GetMissionWorkConversation,
  Mission,
  MissionChatQuery,
  MissionChatSnapshot,
  MissionChatUpdate,
  MissionContextCompactionResult,
  MissionHumanInteraction,
  MissionWorkConversationSnapshot,
  MissionWorkSnapshot,
  MissionWorkUpdate,
  UpdateMissionContextMounts,
  UpdateMissionOptions,
} from "../../../shared/contracts/index.ts";
import type { RuntimeEnvironmentBinding } from "@pragma/shared";

export type MissionSurfaceAudience = "user" | "internal";

export interface MissionChatNotification {
  readonly audience: MissionSurfaceAudience;
  readonly update: MissionChatUpdate;
}

export interface MissionMessageApplicationResult {
  readonly mission: Mission;
  readonly requestId: string;
  readonly requestedMode: "enqueue" | "steer";
  readonly effectiveMode: "enqueue" | "steer";
  readonly fallbackReason?: string | undefined;
}

export interface MissionWorkNotification {
  readonly audience: MissionSurfaceAudience;
  readonly update: MissionWorkUpdate;
}

export interface MissionCommandOutcomeNotification {
  readonly missionId: string;
  readonly requestId: string;
  readonly state: "applied" | "rejected";
  readonly result?: Readonly<Record<string, unknown>> | undefined;
  readonly error?: IntegrationError | undefined;
}

export interface MissionRunner {
  reconcileUsage(): Promise<void>;
  invalidateEstimatedContextWindows(): Promise<void>;
  refreshMemoryContextBindings(): Promise<void>;
  get(id: string): Promise<Mission>;
  run(id: string): Promise<Mission>;
  startLocalHostRun(input: {
    readonly request: LocalHostRunRequest;
    readonly executor: ResolvedRunExecutor;
    readonly missionId: string;
    readonly onEvent?: ((event: LocalHostRunEvent) => void) | undefined;
  }): Promise<LocalHostRunHandle>;
  assertLocalHostRunAllowed(input: {
    readonly request: LocalHostRunRequest;
    readonly executor: ResolvedRunExecutor;
    readonly missionId: string;
    readonly payloadHash?: string | undefined;
  }): Promise<void>;
  createLocalHostMissionControlAdapter(options?: {
    readonly onCommandOutcome?: ((requestId: string) => void | Promise<void>) | undefined;
  }): {
    readonly consumer: MissionCommandConsumer;
    readonly assertAcquisitionAllowed: (missionId: string) => Promise<void>;
    readonly resolveStrictTarget: (input: {
      readonly missionId: string;
      readonly expectedExecutionId?: string | undefined;
    }) => Promise<MissionControlTargetResolution | undefined>;
    readonly resolveExecutionTarget: (input: {
      readonly missionId: string;
      readonly expectedExecutionId?: string | undefined;
    }) => Promise<string | undefined>;
  };
  updateOptions(input: UpdateMissionOptions): Promise<Mission>;
  updateContextMounts(input: UpdateMissionContextMounts): Promise<Mission>;
  invalidateContextBindings(id: string): Promise<void>;
  sendMessage(input: {
    readonly id: string;
    readonly content: string;
    readonly requestId: string;
    readonly attachments?: readonly ExpertPromptAttachment[] | undefined;
    readonly mode?: "enqueue" | "steer" | undefined;
  }): Promise<MissionMessageApplicationResult>;
  steerQueuedMessage(input: { readonly id: string; readonly requestId: string }): Promise<Mission>;
  removeQueuedMessage(input: { readonly id: string; readonly requestId: string }): Promise<Mission>;
  getChat(input: MissionChatQuery): Promise<MissionChatSnapshot>;
  getTerminalRuntimeFailure(id: string): Promise<
    | {
        readonly message: string;
        readonly code?: string | undefined;
        readonly retryable?: boolean | undefined;
        readonly httpStatus?: number | undefined;
        readonly requestId?: string | undefined;
        readonly endpoint?: string | undefined;
        readonly failedAt: string;
      }
    | undefined
  >;
  getTerminalRuntimeOutputDiagnostic(id: string): Promise<
    | {
        readonly finishReason?: "stop" | "length" | "toolUse" | "error" | "aborted" | undefined;
        readonly responseModel?: string | undefined;
        readonly usage?: AgentMessageUsage | undefined;
      }
    | undefined
  >;
  compactContext(id: string): Promise<MissionContextCompactionResult>;
  getRuntimeBinding(id: string): Promise<RuntimeEnvironmentBinding | undefined>;
  subscribeChat(listener: (notification: MissionChatNotification) => void): () => void;
  subscribeWork(listener: (notification: MissionWorkNotification) => void): () => void;
  subscribeCommandOutcomes(
    listener: (notification: MissionCommandOutcomeNotification) => void,
  ): () => void;
  interrupt(id: string, expectedExecutionId?: string): Promise<Mission>;
  stopLocalController(id: string): Promise<void>;
  getCanonicalStrictTarget(
    id: string,
  ): Promise<{ readonly executionId: string; readonly turnId: string } | undefined>;
  resumeQueue(id: string): Promise<Mission>;
  getWork(id: string): Promise<MissionWorkSnapshot>;
  getWorkConversation(input: GetMissionWorkConversation): Promise<MissionWorkConversationSnapshot>;
  listPromptQueue?(id: string): Promise<PromptQueueProjection>;
  delete(id: string): Promise<void>;
  listHumanInteractions(id: string): Promise<readonly MissionHumanInteraction[]>;
  respondToHumanInteraction(input: {
    readonly missionId: string;
    readonly interactionId: string;
    readonly requestId: string;
    readonly response: HumanInteractionResponse;
  }): Promise<void>;
}
