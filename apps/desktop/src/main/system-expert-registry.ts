import {
  BUILT_IN_STEWARD_REF,
  builtInStewardFingerprint,
  builtInStewardResource,
} from "@pragma/steward";

import {
  ExpertDefinitionSchema,
  ExpertSummarySchema,
  MissionExecutorOptionSchema,
  MissionExecutorSchema,
  type ExpertDefinition,
  type ExpertSummary,
  type MissionExecutor,
  type MissionExecutorOption,
} from "../shared/desktop-api.ts";

const BUILT_IN_TIMESTAMP = "1970-01-01T00:00:00.000Z";

export interface DesktopSystemExpertRegistry {
  list(): readonly ExpertSummary[];
  get(ref: string): ExpertDefinition | undefined;
  getExecutor(ref: string): MissionExecutor | undefined;
  listExecutors(): readonly MissionExecutorOption[];
  fingerprint(ref: string): string | undefined;
  isReservedRef(ref: string): boolean;
  isReservedId(id: string): boolean;
}

export function createDesktopSystemExpertRegistry(): DesktopSystemExpertRegistry {
  const resource = builtInStewardResource();
  const fingerprint = builtInStewardFingerprint();
  const definition = ExpertDefinitionSchema.parse({
    schemaVersion: "pragma.desktop-expert-view/v1",
    ref: BUILT_IN_STEWARD_REF,
    id: resource.metadata.id,
    name: resource.metadata.name,
    description: resource.metadata.description,
    tags: resource.metadata.tags,
    version: resource.metadata.version,
    scope: resource.spec.scope,
    instructions: resource.spec.instructions,
    origin: "built-in",
    readOnly: true,
    executionProfile: { mode: "system-default" },
    capabilities: [],
    opaqueCapabilities: resource.spec.capabilities,
    toolApprovals: resource.spec.toolApprovals,
    plugins: [],
    contextStoreMounts: [],
    resourceTools: [],
    revision: 1,
    createdAt: BUILT_IN_TIMESTAMP,
    updatedAt: BUILT_IN_TIMESTAMP,
  });
  const summary = ExpertSummarySchema.parse(definition);
  const executor = MissionExecutorSchema.parse({
    kind: "expert",
    ref: definition.ref,
    name: definition.name,
    version: definition.version,
  });
  const option = MissionExecutorOptionSchema.parse({
    ...executor,
    description: definition.description,
    origin: definition.origin,
    readOnly: definition.readOnly,
  });

  return {
    list: () => [summary],
    get: (ref) => (ref === definition.ref ? definition : undefined),
    getExecutor: (ref) => (ref === executor.ref ? executor : undefined),
    listExecutors: () => [option],
    fingerprint: (ref) => (ref === definition.ref ? fingerprint : undefined),
    isReservedRef: (ref) => ref === definition.ref,
    isReservedId: (id) => id === definition.id,
  };
}
