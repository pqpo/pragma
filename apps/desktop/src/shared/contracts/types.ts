import { z } from "zod";

import {
  AllocatePragmaResourceIdResultSchema,
  DeletePragmaResourceSchema,
  PragmaProjectChangesSchema,
  PragmaProjectChangesValidationResultSchema,
  PragmaProjectSnapshotSchema,
  PragmaFlowRunDrySuiteResultSchema,
  PragmaYamlValidationResultSchema,
  PublishPragmaProjectSchema,
  RunPragmaFlowDrySuiteSchema,
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
  ImportSkillCapabilitySchema,
  PreviewCodeServiceRequestSchema,
  PreviewCodeServiceResultSchema,
  SkillDocumentSchema,
  UpdateCapabilitySchema,
} from "./capabilities.ts";
import {
  ContextStoreContentMetadataSchema,
  ContextStoreContentSchema,
  ContextStoreContentSummarySchema,
  ContextStoreEntrySchema,
  ContextStoreImportInspectionSchema,
  ContextStoreSchema,
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
  RuntimeEnvironmentCatalogEntrySchema,
  RuntimeEnvironmentDefinitionSchema,
  RuntimeEnvironmentRevisionSchema,
  RuntimeGatewayConfigSchema,
  SetDefaultRuntimeSchema,
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
  MissionCreationDefaultsSchema,
  MissionExecutorOptionSchema,
  MissionModelOverrideSchema,
} from "./mission-base.ts";
export type DesktopAppInfo = z.infer<typeof DesktopAppInfoSchema>;
export type RuntimeGatewayConfig = z.infer<typeof RuntimeGatewayConfigSchema>;
export type LocalRuntimeCapability = z.infer<typeof LocalRuntimeCapabilitySchema>;
export type DesktopRuntimeAvailability = z.infer<typeof DesktopRuntimeAvailabilitySchema>;
export type SetDefaultRuntime = z.infer<typeof SetDefaultRuntimeSchema>;
export type DesktopRuntimeModel = z.infer<typeof DesktopRuntimeModelSchema>;
export type RuntimeEnvironmentDefinition = z.infer<typeof RuntimeEnvironmentDefinitionSchema>;
export type RuntimeEnvironmentRevision = z.infer<typeof RuntimeEnvironmentRevisionSchema>;
export type RuntimeEnvironmentCatalogEntry = z.infer<typeof RuntimeEnvironmentCatalogEntrySchema>;
export type DesktopBridgeSnapshot = z.infer<typeof DesktopBridgeSnapshotSchema>;
export type DesktopLocalePreference = z.infer<typeof DesktopLocalePreferenceSchema>;
export type DesktopResolvedLocale = z.infer<typeof DesktopResolvedLocaleSchema>;
export type DesktopSettings = z.infer<typeof DesktopSettingsSchema>;
export type DesktopSettingsSnapshot = z.infer<typeof DesktopSettingsSnapshotSchema>;
export type UpdateDesktopSettings = z.infer<typeof UpdateDesktopSettingsSchema>;
export type DesktopToolPermissionMode = z.infer<typeof DesktopToolPermissionModeSchema>;
export type PickWorkspaceResult = z.infer<typeof PickWorkspaceResultSchema>;
export type ValidateWorkspaceResult = z.infer<typeof ValidateWorkspaceResultSchema>;
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
export type RunPragmaFlowDrySuite = z.infer<typeof RunPragmaFlowDrySuiteSchema>;
export type PragmaFlowRunDrySuiteResult = z.infer<typeof PragmaFlowRunDrySuiteResultSchema>;
export type WorkflowLayout = z.infer<typeof WorkflowLayoutSchema>;
export type GetWorkflowLayout = z.infer<typeof GetWorkflowLayoutSchema>;
export type DeleteWorkflowLayout = z.infer<typeof DeleteWorkflowLayoutSchema>;
export type Mission = z.infer<typeof MissionSchema>;
export type MissionSummary = z.infer<typeof MissionSummarySchema>;
export type MissionUpdate = z.infer<typeof MissionUpdateSchema>;
export type MissionExecutorOption = z.infer<typeof MissionExecutorOptionSchema>;
export type MissionCreationDefaults = z.infer<typeof MissionCreationDefaultsSchema>;
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
export type CreateCapability = z.infer<typeof CreateCapabilitySchema>;
export type UpdateCapability = z.infer<typeof UpdateCapabilitySchema>;
export type CapabilityDeleteResult = z.infer<typeof CapabilityDeleteResultSchema>;
export type GetSkillDocument = z.infer<typeof GetSkillDocumentSchema>;
export type SkillDocument = z.infer<typeof SkillDocumentSchema>;
export type CapabilityTestRequest = z.infer<typeof CapabilityTestRequestSchema>;
export type CapabilityTestResult = z.infer<typeof CapabilityTestResultSchema>;
export type PreviewCodeServiceRequest = z.infer<typeof PreviewCodeServiceRequestSchema>;
export type PreviewCodeServiceResult = z.infer<typeof PreviewCodeServiceResultSchema>;
