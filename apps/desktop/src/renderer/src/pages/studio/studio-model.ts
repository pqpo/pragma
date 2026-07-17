import type { Icon } from "@phosphor-icons/react";
import { Database, GitBranch, User, UsersThree, Wrench } from "@phosphor-icons/react";

import type {
  CreateExpertDefinition,
  ExpertDefinition,
  UpdateExpertDefinition,
} from "../../../../shared/desktop-api.ts";

export type ExpertModel = ExpertDefinition["model"];
export type StudioView = "experts" | "teams" | "flows" | "capabilities" | "context-stores";

export type ExpertRecord = {
  readonly ref?: string | undefined;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly scope: string;
  readonly instructions: string;
  readonly model: ExpertModel;
  readonly capabilities: ExpertDefinition["capabilities"];
  readonly skills: number;
  readonly tools: number;
  readonly mcpServers: number;
  readonly contextStoreMounts: ExpertDefinition["contextStoreMounts"];
  readonly resourceTools: ExpertDefinition["resourceTools"];
  readonly usesApproval: boolean;
  readonly icon: Icon;
  readonly persisted?: ExpertDefinition | undefined;
};

export type ExpertDraft = Omit<ExpertRecord, "icon"> & { readonly tagInput: string };

export const emptyDraft = (): ExpertDraft => ({
  id: "",
  name: "",
  description: "",
  tags: [],
  version: "0.1.0",
  scope: "",
  instructions: "",
  model: null,
  capabilities: [],
  skills: 0,
  tools: 0,
  mcpServers: 0,
  contextStoreMounts: [],
  resourceTools: [],
  usesApproval: false,
  tagInput: "",
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
    model: definition.model,
    capabilities: definition.capabilities,
    skills: definition.capabilities.filter((reference) => reference.kind === "skill").length,
    tools: definition.capabilities
      .filter((reference) => reference.kind === "tools")
      .reduce((total, reference) => total + reference.toolNames.length, 0),
    mcpServers: definition.capabilities.filter((reference) => reference.kind === "tools").length,
    contextStoreMounts: definition.contextStoreMounts,
    resourceTools: definition.resourceTools,
    usesApproval: Object.values(definition.toolApprovals).some((mode) => mode !== "none"),
    icon: User,
    persisted: definition,
  };
}

export function toPersistedInput(
  expert: ExpertRecord,
): CreateExpertDefinition | UpdateExpertDefinition {
  const existing = expert.persisted;
  return {
    ...(existing === undefined ? { id: expert.id } : {}),
    name: expert.name,
    description: expert.description,
    tags: [...expert.tags],
    version: expert.version,
    scope: expert.scope,
    instructions: expert.instructions || undefined,
    model: expert.model,
    capabilities: [...expert.capabilities],
    toolApprovals: existing?.toolApprovals ?? {},
    plugins: existing?.plugins ?? [],
    contextStoreMounts: [...expert.contextStoreMounts],
    resourceTools: [...expert.resourceTools],
    opaqueCapabilities: [...(existing?.opaqueCapabilities ?? [])],
    ...(expert.model === null && existing?.resourceRuntime !== undefined
      ? { resourceRuntime: existing.resourceRuntime }
      : {}),
  };
}

export function desktopApi() {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}

export const studioSections = [
  { id: "experts", label: "Experts", icon: User },
  { id: "teams", label: "Expert teams", icon: UsersThree },
  { id: "flows", label: "Flows", icon: GitBranch },
  { id: "capabilities", label: "Capabilities", icon: Wrench },
  { id: "context-stores", label: "Context stores", icon: Database },
] as const satisfies readonly {
  readonly id: StudioView;
  readonly label: string;
  readonly icon: Icon;
}[];
