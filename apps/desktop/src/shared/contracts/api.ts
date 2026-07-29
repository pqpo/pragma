import type { DesktopRendererLog } from "./logging.ts";
import type {
  DesktopRuntimeAvailability,
  SetDefaultRuntime,
  DesktopBridgeSnapshot,
  DesktopSettingsSnapshot,
  UpdateDesktopSettings,
  PickWorkspaceResult,
  ValidateWorkspaceResult,
  ModelCompatibilityProfileDescriptor,
  ModelProvider,
  CreateModelProvider,
  UpdateModelProvider,
  DeleteModelProvider,
  ModelConnectionTestRequest,
  ModelConnectionTestResult,
  DiscoverProviderModels,
  ModelDiscoveryResult,
  ModelProviderSettingsSnapshot,
  ResetModelProvidersResult,
  ContextStore,
  CreateContextStore,
  DeleteContextStore,
  InspectContextStoreImport,
  ContextStoreImportInspection,
  ContextStoreContent,
  GetContextStoreContent,
  ContextStoreEntry,
  ListContextStoreEntries,
  CreateContextStoreFolder,
  CreateContextStoreFile,
  UpdateContextStoreFile,
  RenameContextStoreEntry,
  DeleteContextStoreEntry,
  DesktopPlugin,
  PluginZipInspection,
  ImportPluginZip,
  UpdatePluginDefaults,
  ExpertDefinition,
  ExpertSummary,
  CreateExpertDefinition,
  UpdateExpertDefinition,
  UpdateBuiltInExpertDefinition,
  PragmaProjectSnapshot,
  PublishPragmaProject,
  UpsertPragmaResource,
  AllocatePragmaResourceIdResult,
  PragmaProjectChanges,
  PragmaProjectChangesValidationResult,
  DeletePragmaResource,
  PragmaYamlValidationResult,
  ValidatePragmaResource,
  RunPragmaEvaluation,
  PragmaFlowRunDrySuiteResult,
  WorkflowLayout,
  GetWorkflowLayout,
  DeleteWorkflowLayout,
  Mission,
  MissionSummary,
  MissionUpdate,
  MissionExecutorOption,
  MissionCreationDefaults,
  AutomationSummary,
  SaveAutomation,
  DeleteAutomation,
  PreviewAutomationSchedule,
  AutomationSchedulePreview,
  AutomationAdapterOption,
  MissionModelOptions,
  CreateMission,
  UpdateMissionOptions,
  MissionWorkSnapshot,
  GetMissionWorkConversation,
  MissionWorkConversationSnapshot,
  MissionWorkUpdate,
  GetMissionChat,
  SendMissionMessage,
  MissionHumanInteraction,
  MissionChatSnapshot,
  MissionContextWindowState,
  MissionChatUpdate,
  RespondMissionHumanInteraction,
  Capability,
  ImportSkillCapability,
  CreateCapability,
  UpdateCapability,
  CapabilityDeleteResult,
  GetSkillDocument,
  SkillDocument,
  CapabilityTestRequest,
  CapabilityTestResult,
  PreviewCodeServiceRequest,
  PreviewCodeServiceResult,
  UsageOverviewRequest,
  UsageOverview,
  UsageSubjectListRequest,
  UsageSubjectList,
  MissionUsage,
  UsageUpdate,
} from "./types.ts";

export interface PragmaDesktopAPI {
  reportRendererLog: (input: DesktopRendererLog) => void;
  getBridgeSnapshot: () => Promise<DesktopBridgeSnapshot>;
  getDesktopSettings: () => Promise<DesktopSettingsSnapshot>;
  updateDesktopSettings: (input: UpdateDesktopSettings) => Promise<DesktopSettingsSnapshot>;
  pickWorkspace: () => Promise<PickWorkspaceResult>;
  validateWorkspace: (path: string) => Promise<ValidateWorkspaceResult>;
  getModelProviderSettings: () => Promise<ModelProviderSettingsSnapshot>;
  listModelCompatibilityProfiles: () => Promise<ModelCompatibilityProfileDescriptor[]>;
  listModelProviders: () => Promise<ModelProvider[]>;
  createModelProvider: (input: CreateModelProvider) => Promise<ModelProvider>;
  updateModelProvider: (input: UpdateModelProvider) => Promise<ModelProvider>;
  deleteModelProvider: (input: DeleteModelProvider) => Promise<void>;
  discoverProviderModels: (input: DiscoverProviderModels) => Promise<ModelDiscoveryResult>;
  testModelConnection: (input: ModelConnectionTestRequest) => Promise<ModelConnectionTestResult>;
  resetModelProviders: () => Promise<ResetModelProvidersResult>;
  listContextStores: () => Promise<ContextStore[]>;
  createContextStore: (input: CreateContextStore) => Promise<ContextStore>;
  inspectContextStoreImport: (
    input: InspectContextStoreImport,
  ) => Promise<ContextStoreImportInspection>;
  deleteContextStore: (input: DeleteContextStore) => Promise<void>;
  getContextStoreContent: (input: GetContextStoreContent) => Promise<ContextStoreContent>;
  listContextStoreEntries: (input: ListContextStoreEntries) => Promise<ContextStoreEntry[]>;
  createContextStoreFolder: (input: CreateContextStoreFolder) => Promise<void>;
  createContextStoreFile: (input: CreateContextStoreFile) => Promise<ContextStoreContent>;
  updateContextStoreFile: (input: UpdateContextStoreFile) => Promise<ContextStoreContent>;
  renameContextStoreEntry: (input: RenameContextStoreEntry) => Promise<void>;
  deleteContextStoreEntry: (input: DeleteContextStoreEntry) => Promise<void>;
  subscribeContextStoreChanges: (storeId: string, listener: () => void) => () => void;
  pickContextStoreFolder: () => Promise<PickWorkspaceResult>;
  listExperts: () => Promise<ExpertSummary[]>;
  getExpert: (ref: string) => Promise<ExpertDefinition>;
  createExpert: (input: CreateExpertDefinition) => Promise<ExpertDefinition>;
  updateExpert: (ref: string, input: UpdateExpertDefinition) => Promise<ExpertDefinition>;
  updateBuiltInExpert: (
    ref: string,
    input: UpdateBuiltInExpertDefinition,
  ) => Promise<ExpertDefinition>;
  resetBuiltInExpert: (ref: string) => Promise<ExpertDefinition>;
  deleteExpert: (ref: string) => Promise<void>;
  listPlugins: () => Promise<DesktopPlugin[]>;
  getPlugin: (ref: string) => Promise<DesktopPlugin>;
  pickPluginZip: () => Promise<PickWorkspaceResult>;
  inspectPluginZip: (sourcePath: string) => Promise<PluginZipInspection>;
  importPluginZip: (input: ImportPluginZip) => Promise<DesktopPlugin>;
  updatePluginDefaults: (input: UpdatePluginDefaults) => Promise<DesktopPlugin>;
  setPluginSecrets: (secrets: Readonly<Record<string, string | null>>) => Promise<void>;
  deletePlugin: (ref: string) => Promise<void>;
  getPragmaProject: () => Promise<PragmaProjectSnapshot>;
  allocatePragmaResourceId: () => Promise<AllocatePragmaResourceIdResult>;
  publishPragmaProject: (input: PublishPragmaProject) => Promise<PragmaProjectSnapshot>;
  upsertPragmaResource: (input: UpsertPragmaResource) => Promise<PragmaProjectSnapshot>;
  applyPragmaProjectChanges: (input: PragmaProjectChanges) => Promise<PragmaProjectSnapshot>;
  deletePragmaResource: (input: DeletePragmaResource) => Promise<PragmaProjectSnapshot>;
  validatePragmaYaml: (source: string) => Promise<PragmaYamlValidationResult>;
  validatePragmaResource: (input: ValidatePragmaResource) => Promise<PragmaYamlValidationResult>;
  validatePragmaProjectChanges: (
    input: PragmaProjectChanges,
  ) => Promise<PragmaProjectChangesValidationResult>;
  runPragmaEvaluation: (input: RunPragmaEvaluation) => Promise<PragmaFlowRunDrySuiteResult>;
  getWorkflowLayout: (input: GetWorkflowLayout) => Promise<WorkflowLayout | null>;
  saveWorkflowLayout: (layout: WorkflowLayout) => Promise<WorkflowLayout>;
  deleteWorkflowLayout: (input: DeleteWorkflowLayout) => Promise<void>;
  listAutomationAdapters: () => Promise<AutomationAdapterOption[]>;
  listAutomations: () => Promise<AutomationSummary[]>;
  saveAutomation: (input: SaveAutomation) => Promise<AutomationSummary>;
  deleteAutomation: (input: DeleteAutomation) => Promise<void>;
  resetAutomationSession: (ref: string) => Promise<AutomationSummary>;
  previewAutomationSchedule: (
    input: PreviewAutomationSchedule,
  ) => Promise<AutomationSchedulePreview>;
  listMissions: () => Promise<MissionSummary[]>;
  listMissionExecutors: () => Promise<MissionExecutorOption[]>;
  getMissionModelOptions: (
    executorRef: string,
    missionId?: string | undefined,
  ) => Promise<MissionModelOptions>;
  subscribeRuntimeModelCatalog: (listener: (runtimeId: string) => void) => () => void;
  getMissionCreationDefaults: () => Promise<MissionCreationDefaults>;
  getMission: (id: string) => Promise<Mission>;
  subscribeMissionUpdates: (listener: (update: MissionUpdate) => void) => () => void;
  createMission: (input: CreateMission) => Promise<Mission>;
  updateMissionOptions: (input: UpdateMissionOptions) => Promise<Mission>;
  runMission: (id: string) => Promise<Mission>;
  sendMissionMessage: (input: SendMissionMessage) => Promise<Mission>;
  getMissionChat: (input: GetMissionChat) => Promise<MissionChatSnapshot>;
  compactMissionContext: (id: string) => Promise<MissionContextWindowState>;
  subscribeMissionChat: (id: string, listener: (update: MissionChatUpdate) => void) => () => void;
  interruptMission: (id: string) => Promise<Mission>;
  getMissionWork: (id: string) => Promise<MissionWorkSnapshot>;
  getMissionWorkConversation: (
    input: GetMissionWorkConversation,
  ) => Promise<MissionWorkConversationSnapshot>;
  subscribeMissionWork: (id: string, listener: (update: MissionWorkUpdate) => void) => () => void;
  deleteMission: (id: string) => Promise<void>;
  listMissionHumanInteractions: (id: string) => Promise<MissionHumanInteraction[]>;
  respondToMissionHumanInteraction: (input: RespondMissionHumanInteraction) => Promise<void>;
  markMissionComplete: (id: string) => Promise<Mission>;
  reopenMission: (id: string) => Promise<Mission>;
  getUsageOverview: (input: UsageOverviewRequest) => Promise<UsageOverview>;
  listUsageSubjects: (input: UsageSubjectListRequest) => Promise<UsageSubjectList>;
  getMissionUsage: (missionId: string) => Promise<MissionUsage>;
  subscribeUsageUpdates: (listener: (update: UsageUpdate) => void) => () => void;
  listCapabilities: () => Promise<Capability[]>;
  getCapability: (id: string, revision?: number) => Promise<Capability>;
  getSkillDocument: (input: GetSkillDocument) => Promise<SkillDocument>;
  importSkillCapability: (input: ImportSkillCapability) => Promise<Capability>;
  createCapability: (input: CreateCapability) => Promise<Capability>;
  updateCapability: (input: UpdateCapability) => Promise<Capability>;
  retryCapability: (id: string) => Promise<Capability>;
  testCapability: (input: CapabilityTestRequest) => Promise<CapabilityTestResult>;
  previewCodeService: (input: PreviewCodeServiceRequest) => Promise<PreviewCodeServiceResult>;
  deleteCapability: (id: string) => Promise<CapabilityDeleteResult>;
  pickSkillSource: () => Promise<PickWorkspaceResult>;
  getRuntimeAvailability: () => Promise<DesktopRuntimeAvailability[]>;
  setDefaultRuntime: (input: SetDefaultRuntime) => Promise<DesktopRuntimeAvailability[]>;
}
