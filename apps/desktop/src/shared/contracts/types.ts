import { z } from "zod";
import { PragmaFlowRunDrySuiteResultSchema } from "@pragma/evaluation/ast";

import {
  AllocatePragmaResourceIdResultSchema,
  DeletePragmaResourceSchema,
  PragmaProjectChangesSchema,
  PragmaProjectChangesValidationResultSchema,
  PragmaProjectSnapshotSchema,
  PragmaYamlValidationResultSchema,
  PublishPragmaProjectSchema,
  RunPragmaEvaluationSchema,
  UpsertPragmaResourceSchema,
  ValidatePragmaResourceSchema,
} from "./projects.ts";
import {
  AutomationAdapterOptionSchema,
  AutomationBindingSchema,
  AutomationRunRecordSchema,
  AutomationSchedulePreviewSchema,
  AutomationSummarySchema,
  DeleteAutomationSchema,
  PreviewAutomationScheduleSchema,
  SaveAutomationSchema,
} from "./automations.ts";
import {
  ExportPragmaBundleSchema,
  InspectPragmaBundleSchema,
  PragmaBundleExportPreviewSchema,
  PragmaBundleExportResultSchema,
  PragmaBundleImportInspectionSchema,
  PragmaBundlePickResultSchema,
  PragmaBundleInstallationActionSchema,
  PragmaBundleInstallationSchema,
  PragmaBundleModuleOptionsSchema,
  PreparePragmaBundleExportSchema,
  ResolvePragmaBundleInstallationSchema,
  StartPragmaBundleImportSchema,
} from "./bundles.ts";
import {
  CapabilityDefinitionSchema,
  CapabilityDeleteResultSchema,
  CapabilityHealthSchema,
  CapabilityManifestSchema,
  CapabilitySchema,
  CapabilityTestRequestSchema,
  CapabilityTestResultSchema,
  CreateCapabilitySchema,
  ExpertCapabilityReferenceSchema,
  ExpertModelConfigSchema,
  GetSkillDocumentSchema,
  GetSkillFileSchema,
  ImportSkillCapabilitySchema,
  ListSkillFilesSchema,
  PreviewCodeServiceRequestSchema,
  PreviewCodeServiceResultSchema,
  SkillDocumentSchema,
  SkillFileContentSchema,
  SkillFileEntrySchema,
  UpdateSkillCapabilitySchema,
  UpdateCapabilitySchema,
} from "./capabilities.ts";
import {
  ContextStoreContentMetadataSchema,
  ContextStoreContentSchema,
  ContextStoreContentSummarySchema,
  ContextStoreChangeSetSchema,
  ContextStoreEntrySchema,
  ContextStoreImportInspectionSchema,
  ContextStoreSchema,
  ContextStoreSnapshotSchema,
  ContextStoreRevisionRecordSchema,
  CreateContextStoreFileSchema,
  CreateContextStoreFolderSchema,
  CreateContextStoreSchema,
  DeleteContextStoreEntrySchema,
  DeleteContextStoreSchema,
  ExpertContextStoreMountSchema,
  GetContextStoreContentSchema,
  InspectContextStoreImportSchema,
  ListContextStoreEntriesSchema,
  RenameContextStoreEntrySchema,
  UpdateContextStoreFileSchema,
} from "./context-stores.ts";
import {
  ContextStoreRevisionJobRefSchema,
  ContextStoreRevisionJobSchema,
  ContextStoreRevisionProfileSchema,
  ContextStoreRevisionRequestSchema,
  ListContextStoreRevisionJobsSchema,
  UpdateContextStoreRevisionProfileSchema,
} from "./context-store-revisions.ts";
import {
  ExpertMemoryContextStoreContentSchema,
  ExpertMemoryContextStoreDescriptorSchema,
  ExpertMemoryContextStoreEntrySchema,
  ExpertMemoryContextStoreSearchMatchSchema,
  GetExpertMemoryContextStoreSchema,
  ListExpertMemoryContextStoreEntriesSchema,
  ReadExpertMemoryContextStoreEntrySchema,
  SearchExpertMemoryContextStoreSchema,
  GetMissionContextStoreSchema,
  ListMissionContextStoreEntriesSchema,
  MissionContextStoreContentSchema,
  MissionContextStoreDescriptorSchema,
  MissionContextStoreEntrySchema,
  MissionContextStoreScopeSchema,
  MissionContextStoreSearchMatchSchema,
  ReadMissionContextStoreEntrySchema,
  SearchMissionContextStoreSchema,
} from "./context-store-browser.ts";
import {
  CreateExpertDefinitionSchema,
  ExpertDefinitionSchema,
  ExpertExecutionProfileSchema,
  ExpertSummarySchema,
  UpdateBuiltInExpertDefinitionSchema,
  UpdateExpertDefinitionSchema,
} from "./experts.ts";
import {
  CreateMissionSchema,
  GetMissionChatSchema,
  GetMissionWorkConversationSchema,
  MissionChatEntrySchema,
  MissionChatPatchSchema,
  MissionChatSnapshotSchema,
  MissionChatUpdateSchema,
  MissionContextCompactionResultSchema,
  MissionContextWindowStateSchema,
  MissionHumanInteractionSchema,
  MissionLifecycleStatusSchema,
  MissionModelOptionsSchema,
  MissionSchema,
  MissionSummarySchema,
  MissionTimelineRecordSchema,
  MissionUpdateSchema,
  MissionUserMessageSchema,
  MissionWorkConversationSnapshotSchema,
  MissionWorkRecordSchema,
  MissionWorkSnapshotSchema,
  MissionWorkTaskSchema,
  MissionWorkUpdateSchema,
  RespondMissionHumanInteractionSchema,
  SendMissionMessageSchema,
  UpdateMissionOptionsSchema,
} from "./missions.ts";
import {
  CreateModelProviderSchema,
  DeleteModelProviderSchema,
  DiscoverProviderModelsSchema,
  ModelCompatibilityProfileDescriptorSchema,
  ModelConnectionTestRequestSchema,
  ModelConnectionTestResultSchema,
  ModelDiscoveryResultSchema,
  ModelProviderModelSchema,
  ModelProviderSchema,
  ModelProviderSettingsSnapshotSchema,
  ModelProviderVerificationSchema,
  ResetModelProvidersResultSchema,
  UpdateModelProviderSchema,
} from "./model-provider.ts";
import {
  DeleteWorkflowLayoutSchema,
  GetWorkflowLayoutSchema,
  WorkflowLayoutSchema,
} from "./workflow-layout.ts";
import {
  DesktopAppInfoSchema,
  DesktopBridgeSnapshotSchema,
  DesktopRuntimeAvailabilitySchema,
  DesktopRuntimeModelSchema,
  LocalRuntimeCapabilitySchema,
  RuntimeEnvironmentCatalogSchema,
  RuntimeEnvironmentCatalogEntrySchema,
  RuntimeEnvironmentDefinitionSchema,
  RuntimeEnvironmentRevisionSchema,
  RuntimeGatewayConfigSchema,
} from "./runtime.ts";
import {
  DesktopLocalePreferenceSchema,
  DesktopResolvedLocaleSchema,
  DesktopSettingsSchema,
  DesktopSettingsSnapshotSchema,
  DesktopToolPermissionModeSchema,
  PickWorkspaceResultSchema,
  UpdateDesktopSettingsSchema,
  ValidateWorkspaceResultSchema,
} from "./settings.ts";
import {
  DesktopPluginManifestSchema,
  DesktopPluginSchema,
  ExpertPluginReferenceSchema,
  ImportPluginZipSchema,
  PluginZipInspectionSchema,
  UpdatePluginDefaultsSchema,
} from "./plugins.ts";
import {
  HomeExecutorFavoriteScopeSchema,
  HomeExecutorPreferenceSchema,
  HomeMissionExecutorCatalogSchema,
  HomeMissionExecutorOptionSchema,
  MissionCreationDefaultsSchema,
  MissionExecutorOptionSchema,
  MissionModelOverrideSchema,
  UpdateHomeExecutorPreferenceSchema,
} from "./mission-base.ts";
import {
  MissionUsageSchema,
  UsageOverviewRequestSchema,
  UsageOverviewSchema,
  UsageSubjectListRequestSchema,
  UsageSubjectListSchema,
  UsageUpdateSchema,
} from "./usage.ts";
import {
  DesktopAssetMemoryPolicySnapshotSchema,
  DesktopGlobalMemoryPolicySnapshotSchema,
  DesktopMemoryPlaneStatusSchema,
  DesktopMemoryExtractorProfileSchema,
  DesktopMemoryExtractionSettingsSchema,
  DesktopMemoryPolicyTargetSchema,
  GetDesktopAssetMemoryPolicySchema,
  UpdateDesktopAssetMemoryPolicySchema,
  UpdateDesktopGlobalMemoryPolicySchema,
  UpdateDesktopMemoryExtractorProfileSchema,
  UpdateDesktopMemoryExtractionSettingsSchema,
  DesktopSemanticFactSchema,
  ReviseDesktopSemanticFactSchema,
  ReviewDesktopSemanticFactSchema,
  DesktopMemoryItemSchema,
  DesktopMemoryEvidenceSchema,
  ListDesktopMemoryItemsSchema,
  DesktopMemoryItemRefSchema,
  GetDesktopMemoryEvidenceSchema,
  TightenDesktopMemoryAccessSchema,
  ReviewDesktopMemoryItemSchema,
  DesktopMissionMemoryActivitySchema,
  GetDesktopMissionMemoryActivitySchema,
  DesktopMemoryExtractionTaskSchema,
  DesktopMemoryExtractionBoardSchema,
  ListDesktopMemoryExtractionJobsSchema,
  ManageDesktopMemoryExtractionTaskSchema,
  MemoryKnowledgeInitializationCandidateSchema,
  ListMemoryKnowledgeInitializationCandidatesSchema,
  MemoryKnowledgeInitializationCandidateRefSchema,
  UpdateMemoryKnowledgeInitializationCandidateSchema,
} from "./memory.ts";
export type DesktopAppInfo = z.infer<typeof DesktopAppInfoSchema>;
export type PragmaBundleModuleOptions = z.infer<typeof PragmaBundleModuleOptionsSchema>;
export type PreparePragmaBundleExport = z.infer<typeof PreparePragmaBundleExportSchema>;
export type PragmaBundleExportPreview = z.infer<typeof PragmaBundleExportPreviewSchema>;
export type ExportPragmaBundle = z.infer<typeof ExportPragmaBundleSchema>;
export type PragmaBundleExportResult = z.infer<typeof PragmaBundleExportResultSchema>;
export type InspectPragmaBundle = z.infer<typeof InspectPragmaBundleSchema>;
export type PragmaBundleImportInspection = z.infer<typeof PragmaBundleImportInspectionSchema>;
export type PragmaBundlePickResult = z.infer<typeof PragmaBundlePickResultSchema>;
export type StartPragmaBundleImport = z.infer<typeof StartPragmaBundleImportSchema>;
export type PragmaBundleInstallation = z.infer<typeof PragmaBundleInstallationSchema>;
export type ResolvePragmaBundleInstallation = z.infer<typeof ResolvePragmaBundleInstallationSchema>;
export type PragmaBundleInstallationAction = z.infer<typeof PragmaBundleInstallationActionSchema>;
export type RuntimeGatewayConfig = z.infer<typeof RuntimeGatewayConfigSchema>;
export type LocalRuntimeCapability = z.infer<typeof LocalRuntimeCapabilitySchema>;
export type DesktopRuntimeAvailability = z.infer<typeof DesktopRuntimeAvailabilitySchema>;
export type DesktopRuntimeModel = z.infer<typeof DesktopRuntimeModelSchema>;
export type RuntimeEnvironmentDefinition = z.infer<typeof RuntimeEnvironmentDefinitionSchema>;
export type RuntimeEnvironmentRevision = z.infer<typeof RuntimeEnvironmentRevisionSchema>;
export type RuntimeEnvironmentCatalogEntry = z.infer<typeof RuntimeEnvironmentCatalogEntrySchema>;
export type RuntimeEnvironmentCatalog = z.infer<typeof RuntimeEnvironmentCatalogSchema>;
export type DesktopBridgeSnapshot = z.infer<typeof DesktopBridgeSnapshotSchema>;
export type DesktopLocalePreference = z.infer<typeof DesktopLocalePreferenceSchema>;
export type DesktopResolvedLocale = z.infer<typeof DesktopResolvedLocaleSchema>;
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export type DesktopSettingsSnapshot = z.infer<typeof DesktopSettingsSnapshotSchema>;
export type UpdateDesktopSettings = z.infer<typeof UpdateDesktopSettingsSchema>;
export type DesktopToolPermissionMode = z.infer<typeof DesktopToolPermissionModeSchema>;
export type PickWorkspaceResult = z.infer<typeof PickWorkspaceResultSchema>;
export type ValidateWorkspaceResult = z.infer<typeof ValidateWorkspaceResultSchema>;
export type UsageOverviewRequest = z.infer<typeof UsageOverviewRequestSchema>;
export type UsageOverview = z.infer<typeof UsageOverviewSchema>;
export type UsageSubjectListRequest = z.infer<typeof UsageSubjectListRequestSchema>;
export type UsageSubjectList = z.infer<typeof UsageSubjectListSchema>;
export type MissionUsage = z.infer<typeof MissionUsageSchema>;
export type UsageUpdate = z.infer<typeof UsageUpdateSchema>;
export type DesktopMemoryPolicyTarget = z.infer<typeof DesktopMemoryPolicyTargetSchema>;
export type DesktopGlobalMemoryPolicySnapshot = z.infer<
  typeof DesktopGlobalMemoryPolicySnapshotSchema
>;
export type DesktopAssetMemoryPolicySnapshot = z.infer<
  typeof DesktopAssetMemoryPolicySnapshotSchema
>;
export type UpdateDesktopGlobalMemoryPolicy = z.infer<typeof UpdateDesktopGlobalMemoryPolicySchema>;
export type GetDesktopAssetMemoryPolicy = z.infer<typeof GetDesktopAssetMemoryPolicySchema>;
export type UpdateDesktopAssetMemoryPolicy = z.infer<typeof UpdateDesktopAssetMemoryPolicySchema>;
export type DesktopMemoryPlaneStatus = z.infer<typeof DesktopMemoryPlaneStatusSchema>;
export type DesktopMemoryExtractorProfile = z.infer<typeof DesktopMemoryExtractorProfileSchema>;
export type UpdateDesktopMemoryExtractorProfile = z.infer<
  typeof UpdateDesktopMemoryExtractorProfileSchema
>;
export type DesktopMemoryExtractionSettings = z.infer<typeof DesktopMemoryExtractionSettingsSchema>;
export type UpdateDesktopMemoryExtractionSettings = z.infer<
  typeof UpdateDesktopMemoryExtractionSettingsSchema
>;
export type DesktopSemanticFact = z.infer<typeof DesktopSemanticFactSchema>;
export type ReviseDesktopSemanticFact = z.infer<typeof ReviseDesktopSemanticFactSchema>;
export type ReviewDesktopSemanticFact = z.infer<typeof ReviewDesktopSemanticFactSchema>;
export type DesktopMemoryItem = z.infer<typeof DesktopMemoryItemSchema>;
export type DesktopMemoryEvidence = z.infer<typeof DesktopMemoryEvidenceSchema>;
export type ListDesktopMemoryItems = z.input<typeof ListDesktopMemoryItemsSchema>;
export type DesktopMemoryItemRef = z.infer<typeof DesktopMemoryItemRefSchema>;
export type GetDesktopMemoryEvidence = z.infer<typeof GetDesktopMemoryEvidenceSchema>;
export type TightenDesktopMemoryAccess = z.infer<typeof TightenDesktopMemoryAccessSchema>;
export type ReviewDesktopMemoryItem = z.infer<typeof ReviewDesktopMemoryItemSchema>;
export type DesktopMissionMemoryActivity = z.infer<typeof DesktopMissionMemoryActivitySchema>;
export type GetDesktopMissionMemoryActivity = z.infer<typeof GetDesktopMissionMemoryActivitySchema>;
export type DesktopMemoryExtractionTask = z.infer<typeof DesktopMemoryExtractionTaskSchema>;
export type DesktopMemoryExtractionBoard = z.infer<typeof DesktopMemoryExtractionBoardSchema>;
export type ListDesktopMemoryExtractionJobs = z.infer<typeof ListDesktopMemoryExtractionJobsSchema>;
export type ManageDesktopMemoryExtractionTask = z.infer<
  typeof ManageDesktopMemoryExtractionTaskSchema
>;
export type MemoryKnowledgeInitializationCandidate = z.infer<
  typeof MemoryKnowledgeInitializationCandidateSchema
>;
export type ListMemoryKnowledgeInitializationCandidates = z.input<
  typeof ListMemoryKnowledgeInitializationCandidatesSchema
>;
export type MemoryKnowledgeInitializationCandidateRef = z.infer<
  typeof MemoryKnowledgeInitializationCandidateRefSchema
>;
export type UpdateMemoryKnowledgeInitializationCandidate = z.infer<
  typeof UpdateMemoryKnowledgeInitializationCandidateSchema
>;
export type ModelProviderModel = z.infer<typeof ModelProviderModelSchema>;
export type ModelCompatibilityProfileDescriptor = z.infer<
  typeof ModelCompatibilityProfileDescriptorSchema
>;
export type ModelProviderVerification = z.infer<typeof ModelProviderVerificationSchema>;
export type ModelProvider = z.infer<typeof ModelProviderSchema>;
export type CreateModelProvider = z.infer<typeof CreateModelProviderSchema>;
export type UpdateModelProvider = z.infer<typeof UpdateModelProviderSchema>;
export type DeleteModelProvider = z.infer<typeof DeleteModelProviderSchema>;
export type ModelConnectionTestRequest = z.infer<typeof ModelConnectionTestRequestSchema>;
export type ModelConnectionTestResult = z.infer<typeof ModelConnectionTestResultSchema>;
export type DiscoverProviderModels = z.infer<typeof DiscoverProviderModelsSchema>;
export type ModelDiscoveryResult = z.infer<typeof ModelDiscoveryResultSchema>;
export type ModelProviderSettingsSnapshot = z.infer<typeof ModelProviderSettingsSnapshotSchema>;
export type ResetModelProvidersResult = z.infer<typeof ResetModelProvidersResultSchema>;
export type ContextStore = z.infer<typeof ContextStoreSchema>;
export type ContextStoreSnapshot = z.infer<typeof ContextStoreSnapshotSchema>;
export type ContextStoreChangeSet = z.infer<typeof ContextStoreChangeSetSchema>;
export type ContextStoreRevisionRecord = z.infer<typeof ContextStoreRevisionRecordSchema>;
export type ContextStoreRevisionRequest = z.infer<typeof ContextStoreRevisionRequestSchema>;
export type ContextStoreRevisionJob = z.infer<typeof ContextStoreRevisionJobSchema>;
export type ListContextStoreRevisionJobs = z.infer<typeof ListContextStoreRevisionJobsSchema>;
export type ContextStoreRevisionJobRef = z.infer<typeof ContextStoreRevisionJobRefSchema>;
export type ContextStoreRevisionProfile = z.infer<typeof ContextStoreRevisionProfileSchema>;
export type UpdateContextStoreRevisionProfile = z.infer<
  typeof UpdateContextStoreRevisionProfileSchema
>;
export type CreateContextStore = z.infer<typeof CreateContextStoreSchema>;
export type DeleteContextStore = z.infer<typeof DeleteContextStoreSchema>;
export type InspectContextStoreImport = z.infer<typeof InspectContextStoreImportSchema>;
export type ContextStoreImportInspection = z.infer<typeof ContextStoreImportInspectionSchema>;
export type ContextStoreContentMetadata = z.infer<typeof ContextStoreContentMetadataSchema>;
export type ContextStoreContentSummary = z.infer<typeof ContextStoreContentSummarySchema>;
export type ContextStoreContent = z.infer<typeof ContextStoreContentSchema>;
export type GetContextStoreContent = z.infer<typeof GetContextStoreContentSchema>;
export type ContextStoreEntry = z.infer<typeof ContextStoreEntrySchema>;
export type ListContextStoreEntries = z.infer<typeof ListContextStoreEntriesSchema>;
export type CreateContextStoreFolder = z.infer<typeof CreateContextStoreFolderSchema>;
export type CreateContextStoreFile = z.infer<typeof CreateContextStoreFileSchema>;
export type UpdateContextStoreFile = z.infer<typeof UpdateContextStoreFileSchema>;
export type RenameContextStoreEntry = z.infer<typeof RenameContextStoreEntrySchema>;
export type DeleteContextStoreEntry = z.infer<typeof DeleteContextStoreEntrySchema>;
export type ExpertContextStoreMount = z.infer<typeof ExpertContextStoreMountSchema>;
export type GetMissionContextStore = z.infer<typeof GetMissionContextStoreSchema>;
export type ListMissionContextStoreEntries = z.infer<typeof ListMissionContextStoreEntriesSchema>;
export type ReadMissionContextStoreEntry = z.infer<typeof ReadMissionContextStoreEntrySchema>;
export type SearchMissionContextStore = z.infer<typeof SearchMissionContextStoreSchema>;
export type MissionContextStoreScope = z.infer<typeof MissionContextStoreScopeSchema>;
export type MissionContextStoreDescriptor = z.infer<typeof MissionContextStoreDescriptorSchema>;
export type MissionContextStoreEntry = z.infer<typeof MissionContextStoreEntrySchema>;
export type MissionContextStoreContent = z.infer<typeof MissionContextStoreContentSchema>;
export type MissionContextStoreSearchMatch = z.infer<typeof MissionContextStoreSearchMatchSchema>;
export type GetExpertMemoryContextStore = z.infer<typeof GetExpertMemoryContextStoreSchema>;
export type ListExpertMemoryContextStoreEntries = z.infer<
  typeof ListExpertMemoryContextStoreEntriesSchema
>;
export type ReadExpertMemoryContextStoreEntry = z.infer<
  typeof ReadExpertMemoryContextStoreEntrySchema
>;
export type SearchExpertMemoryContextStore = z.infer<typeof SearchExpertMemoryContextStoreSchema>;
export type ExpertMemoryContextStoreDescriptor = z.infer<
  typeof ExpertMemoryContextStoreDescriptorSchema
>;
export type ExpertMemoryContextStoreEntry = z.infer<typeof ExpertMemoryContextStoreEntrySchema>;
export type ExpertMemoryContextStoreContent = z.infer<typeof ExpertMemoryContextStoreContentSchema>;
export type ExpertMemoryContextStoreSearchMatch = z.infer<
  typeof ExpertMemoryContextStoreSearchMatchSchema
>;
export type DesktopPluginManifest = z.infer<typeof DesktopPluginManifestSchema>;
export type DesktopPlugin = z.infer<typeof DesktopPluginSchema>;
export type PluginZipInspection = z.infer<typeof PluginZipInspectionSchema>;
export type ImportPluginZip = z.infer<typeof ImportPluginZipSchema>;
export type UpdatePluginDefaults = z.infer<typeof UpdatePluginDefaultsSchema>;
export type ExpertPluginReference = z.infer<typeof ExpertPluginReferenceSchema>;
export type ExpertDefinition = z.infer<typeof ExpertDefinitionSchema>;
export type ExpertExecutionProfile = z.infer<typeof ExpertExecutionProfileSchema>;
export type ExpertModelConfig = z.infer<typeof ExpertModelConfigSchema>;
export type ExpertSummary = z.infer<typeof ExpertSummarySchema>;
export type CreateExpertDefinition = z.infer<typeof CreateExpertDefinitionSchema>;
export type UpdateExpertDefinition = z.infer<typeof UpdateExpertDefinitionSchema>;
export type UpdateBuiltInExpertDefinition = z.infer<typeof UpdateBuiltInExpertDefinitionSchema>;
export type PragmaProjectSnapshot = z.infer<typeof PragmaProjectSnapshotSchema>;
export type PublishPragmaProject = z.infer<typeof PublishPragmaProjectSchema>;
export type UpsertPragmaResource = z.infer<typeof UpsertPragmaResourceSchema>;
export type AllocatePragmaResourceIdResult = z.infer<typeof AllocatePragmaResourceIdResultSchema>;
export type PragmaProjectChanges = z.infer<typeof PragmaProjectChangesSchema>;
export type PragmaProjectChangesValidationResult = z.infer<
  typeof PragmaProjectChangesValidationResultSchema
>;
export type DeletePragmaResource = z.infer<typeof DeletePragmaResourceSchema>;
export type PragmaYamlValidationResult = z.infer<typeof PragmaYamlValidationResultSchema>;
export type ValidatePragmaResource = z.infer<typeof ValidatePragmaResourceSchema>;
export type RunPragmaEvaluation = z.infer<typeof RunPragmaEvaluationSchema>;
export type PragmaFlowRunDrySuiteResult = z.infer<typeof PragmaFlowRunDrySuiteResultSchema>;
export type WorkflowLayout = z.infer<typeof WorkflowLayoutSchema>;
export type GetWorkflowLayout = z.infer<typeof GetWorkflowLayoutSchema>;
export type DeleteWorkflowLayout = z.infer<typeof DeleteWorkflowLayoutSchema>;
export type Mission = z.infer<typeof MissionSchema>;
export type MissionSummary = z.infer<typeof MissionSummarySchema>;
export type MissionUpdate = z.infer<typeof MissionUpdateSchema>;
export type MissionExecutorOption = z.infer<typeof MissionExecutorOptionSchema>;
export type MissionCreationDefaults = z.infer<typeof MissionCreationDefaultsSchema>;
export type HomeExecutorFavoriteScope = z.infer<typeof HomeExecutorFavoriteScopeSchema>;
export type HomeExecutorPreference = z.infer<typeof HomeExecutorPreferenceSchema>;
export type HomeMissionExecutorOption = z.infer<typeof HomeMissionExecutorOptionSchema>;
export type HomeMissionExecutorCatalog = z.infer<typeof HomeMissionExecutorCatalogSchema>;
export type UpdateHomeExecutorPreference = z.infer<typeof UpdateHomeExecutorPreferenceSchema>;
export type MissionModelOverride = z.infer<typeof MissionModelOverrideSchema>;
export type AutomationBinding = z.infer<typeof AutomationBindingSchema>;
export type AutomationRunRecord = z.infer<typeof AutomationRunRecordSchema>;
export type AutomationSummary = z.infer<typeof AutomationSummarySchema>;
export type SaveAutomation = z.infer<typeof SaveAutomationSchema>;
export type DeleteAutomation = z.infer<typeof DeleteAutomationSchema>;
export type PreviewAutomationSchedule = z.infer<typeof PreviewAutomationScheduleSchema>;
export type AutomationSchedulePreview = z.infer<typeof AutomationSchedulePreviewSchema>;
export type AutomationAdapterOption = z.infer<typeof AutomationAdapterOptionSchema>;
export type MissionModelOptions = z.infer<typeof MissionModelOptionsSchema>;
export type MissionLifecycleStatus = z.infer<typeof MissionLifecycleStatusSchema>;
export type CreateMission = z.infer<typeof CreateMissionSchema>;
export type UpdateMissionOptions = z.infer<typeof UpdateMissionOptionsSchema>;
export type MissionUserMessage = z.infer<typeof MissionUserMessageSchema>;
export type MissionTimelineRecord = z.infer<typeof MissionTimelineRecordSchema>;
export type MissionWorkTask = z.infer<typeof MissionWorkTaskSchema>;
export type MissionWorkRecord = z.infer<typeof MissionWorkRecordSchema>;
export type MissionWorkSnapshot = z.infer<typeof MissionWorkSnapshotSchema>;
export type GetMissionWorkConversation = z.infer<typeof GetMissionWorkConversationSchema>;
export type MissionWorkConversationSnapshot = z.infer<typeof MissionWorkConversationSnapshotSchema>;
export type MissionWorkUpdate = z.infer<typeof MissionWorkUpdateSchema>;
export type GetMissionChat = z.input<typeof GetMissionChatSchema>;
export type MissionChatQuery = z.output<typeof GetMissionChatSchema>;
export type SendMissionMessage = z.infer<typeof SendMissionMessageSchema>;
export type MissionHumanInteraction = z.infer<typeof MissionHumanInteractionSchema>;
export type MissionChatEntry = z.infer<typeof MissionChatEntrySchema>;
export type MissionChatSnapshot = z.infer<typeof MissionChatSnapshotSchema>;
export type MissionContextCompactionResult = z.infer<typeof MissionContextCompactionResultSchema>;
export type MissionContextWindowState = z.infer<typeof MissionContextWindowStateSchema>;
export type MissionChatPatch = z.infer<typeof MissionChatPatchSchema>;
export type MissionChatUpdate = z.infer<typeof MissionChatUpdateSchema>;
export type RespondMissionHumanInteraction = z.infer<typeof RespondMissionHumanInteractionSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;
export type CapabilityManifest = z.infer<typeof CapabilityManifestSchema>;
export type CapabilityHealth = z.infer<typeof CapabilityHealthSchema>;
export type CapabilityDefinition = z.infer<typeof CapabilityDefinitionSchema>;
export type ExpertCapabilityReference = z.infer<typeof ExpertCapabilityReferenceSchema>;
export type ImportSkillCapability = z.infer<typeof ImportSkillCapabilitySchema>;
export type UpdateSkillCapability = z.infer<typeof UpdateSkillCapabilitySchema>;
export type CreateCapability = z.infer<typeof CreateCapabilitySchema>;
export type UpdateCapability = z.infer<typeof UpdateCapabilitySchema>;
export type CapabilityDeleteResult = z.infer<typeof CapabilityDeleteResultSchema>;
export type GetSkillDocument = z.infer<typeof GetSkillDocumentSchema>;
export type SkillDocument = z.infer<typeof SkillDocumentSchema>;
export type ListSkillFiles = z.infer<typeof ListSkillFilesSchema>;
export type SkillFileEntry = z.infer<typeof SkillFileEntrySchema>;
export type GetSkillFile = z.infer<typeof GetSkillFileSchema>;
export type SkillFileContent = z.infer<typeof SkillFileContentSchema>;
export type CapabilityTestRequest = z.infer<typeof CapabilityTestRequestSchema>;
export type CapabilityTestResult = z.infer<typeof CapabilityTestResultSchema>;
export type PreviewCodeServiceRequest = z.infer<typeof PreviewCodeServiceRequestSchema>;
export type PreviewCodeServiceResult = z.infer<typeof PreviewCodeServiceResultSchema>;
