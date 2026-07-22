import type { Icon } from "@phosphor-icons/react";
import { Database, GitBranch, PuzzlePiece, User, UsersThree, Wrench } from "@phosphor-icons/react";

import type {
  CreateExpertDefinition,
  ExpertDefinition,
  UpdateExpertDefinition,
} from "../../../../shared/desktop-api.ts";

export type ExpertModel = Extract<
  ExpertDefinition["executionProfile"],
  { readonly mode: "pinned" }
>["model"];
export type StudioView =
  | "experts"
  | "teams"
  | "flows"
  | "capabilities"
  | "plugins"
  | "context-stores";

export type ExpertRecord = {
  readonly ref?: string | undefined;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly scope: string;
  readonly instructions: string;
  readonly additionalInstructions: string;
  readonly origin: ExpertDefinition["origin"];
  readonly readOnly: boolean;
  readonly customized: boolean;
  readonly model: ExpertModel | null;
  readonly capabilities: ExpertDefinition["capabilities"];
  readonly toolApprovals: ExpertDefinition["toolApprovals"];
  readonly skills: number;
  readonly tools: number;
  readonly mcpServers: number;
  readonly contextStoreMounts: ExpertDefinition["contextStoreMounts"];
  readonly resourceTools: ExpertDefinition["resourceTools"];
  readonly plugins: ExpertDefinition["plugins"];
  readonly usesApproval: boolean;
  readonly icon: Icon;
  readonly persisted?: ExpertDefinition | undefined;
};

export type ExpertDraft = Omit<ExpertRecord, "icon" | "model"> & {
  readonly model: ExpertModel | null;
  readonly tagInput: string;
  readonly pluginSecretMutations: Readonly<Record<string, string | null>>;
};

export const emptyDraft = (): ExpertDraft => ({
  id: "",
  name: "",
  description: "",
  tags: [],
  version: "0.1.0",
  scope: "",
  instructions: "",
  additionalInstructions: "",
  origin: "project",
  readOnly: false,
  customized: false,
  model: null,
  capabilities: [],
  toolApprovals: {},
  skills: 0,
  tools: 0,
  mcpServers: 0,
  contextStoreMounts: [],
  resourceTools: [],
  plugins: [],
  usesApproval: false,
  tagInput: "",
  pluginSecretMutations: {},
});

export function toExpertRecord(definition: ExpertDefinition): ExpertRecord {
  return {
    id: definition.id,
    ref: definition.ref,
    name: definition.name,
    description: definition.description,
    tags: definition.tags,
    version: definition.version,
    scope: definition.scope,
    instructions: definition.instructions ?? "",
    additionalInstructions: definition.additionalInstructions,
    origin: definition.origin,
    readOnly: definition.readOnly,
    customized: definition.customized,
    model: definition.executionProfile.mode === "pinned" ? definition.executionProfile.model : null,
    capabilities: definition.capabilities,
    toolApprovals: definition.toolApprovals,
    skills:
      definition.capabilities.filter((reference) => reference.kind === "skill").length +
      (definition.opaqueCapabilities ?? []).filter((reference) => reference.kind === "skill")
        .length,
    tools:
      definition.capabilities
        .filter((reference) => reference.kind === "tools")
        .reduce((total, reference) => total + reference.toolNames.length, 0) +
      (definition.opaqueCapabilities ?? [])
        .filter((reference) => reference.kind === "tools")
        .reduce((total, reference) => total + (reference.tools?.length ?? 0), 0),
    mcpServers:
      definition.capabilities.filter((reference) => reference.kind === "tools").length +
      (definition.opaqueCapabilities ?? []).filter((reference) => reference.kind === "tools")
        .length,
    contextStoreMounts: definition.contextStoreMounts,
    resourceTools: definition.resourceTools,
    plugins: definition.plugins,
    usesApproval: Object.values(definition.toolApprovals).some((mode) => mode !== "none"),
    icon: User,
    persisted: definition,
  };
}

export function isBuiltInExpert(expert: Pick<ExpertRecord, "origin" | "readOnly">): boolean {
  return expert.origin === "built-in";
}

export function toPersistedInput(
  expert: ExpertRecord,
): CreateExpertDefinition | UpdateExpertDefinition {
  if (expert.readOnly || expert.model === null) {
    throw new Error("Built-in Experts cannot be persisted by the Desktop editor.");
  }
  const existing = expert.persisted;
  return {
    ...(existing === undefined ? { id: expert.id } : {}),
    name: expert.name,
    description: expert.description,
    tags: [...expert.tags],
    version: expert.version,
    scope: expert.scope,
    instructions: expert.instructions,
    model: expert.model,
    capabilities: [...expert.capabilities],
    toolApprovals: expert.toolApprovals,
    plugins: [...expert.plugins],
    contextStoreMounts: [...expert.contextStoreMounts],
    resourceTools: [...expert.resourceTools],
    opaqueCapabilities: [...(existing?.opaqueCapabilities ?? [])],
    opaqueContextStores: [...(existing?.opaqueContextStores ?? [])],
  };
}

export function desktopApi() {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}

export const studioSections = [
  { id: "experts", labelKey: "experts", icon: User },
  { id: "teams", labelKey: "teams", icon: UsersThree },
  { id: "flows", labelKey: "flows", icon: GitBranch },
  { id: "capabilities", labelKey: "capabilities", icon: Wrench },
  { id: "plugins", labelKey: "plugins", icon: PuzzlePiece },
  { id: "context-stores", labelKey: "contextStores", icon: Database },
] as const satisfies readonly {
  readonly id: StudioView;
  readonly labelKey: string;
  readonly icon: Icon;
}[];
