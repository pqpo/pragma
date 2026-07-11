import type { Icon } from "@phosphor-icons/react";
import { Database, SquaresFour, User, UsersThree, Wrench } from "@phosphor-icons/react";

import type {
  CreateExpertDefinition,
  ExpertDefinition,
  UpdateExpertDefinition,
} from "../../../../shared/desktop-api.ts";

export type ExpertModel = ExpertDefinition["model"];
export type StudioView = "overview" | "experts" | "teams" | "capabilities" | "context-stores";

export type ExpertRecord = {
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
  usesApproval: false,
  tagInput: "",
});

export function toExpertRecord(definition: ExpertDefinition): ExpertRecord {
  return {
    id: definition.id,
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
  };
}

export function desktopApi() {
  return typeof window === "undefined" ? undefined : window.pragmaDesktop;
}

export const studioSections = [
  { id: "overview", label: "Overview", icon: SquaresFour },
  { id: "experts", label: "Experts", icon: User },
  { id: "teams", label: "Expert teams", icon: UsersThree },
  { id: "capabilities", label: "Capabilities", icon: Wrench },
  { id: "context-stores", label: "Context stores", icon: Database },
] as const satisfies readonly {
  readonly id: StudioView;
  readonly label: string;
  readonly icon: Icon;
}[];

export const studioLabels = {
  experts: "Experts",
  teams: "Expert teams",
  capabilities: "Capabilities",
  "context-stores": "Context stores",
} satisfies Record<Exclude<StudioView, "overview">, string>;

export const studioDescriptions = {
  experts: "Individuals that perform specialized work in your missions.",
  teams: "Groups of experts that work together toward a mission.",
  capabilities: "Reusable skills and external tools selected by experts.",
  "context-stores": "Reusable knowledge sources mounted by experts.",
} satisfies Record<Exclude<StudioView, "overview">, string>;
