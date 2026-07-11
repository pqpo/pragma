import type { Icon } from "@phosphor-icons/react";
import {
  Database,
  Robot,
  SquaresFour,
  TerminalWindow,
  User,
  UsersThree,
  Wrench,
} from "@phosphor-icons/react";

import type {
  CreateExpertDefinition,
  ExpertDefinition,
  UpdateExpertDefinition,
} from "../../../../shared/desktop-api.ts";

export type ExpertModel = ExpertDefinition["model"];
export type StudioView = "overview" | "experts" | "teams" | "tools" | "context-stores";

export type ExpertRecord = {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly scope: string;
  readonly instructions: string;
  readonly model: ExpertModel;
  readonly skills: number;
  readonly tools: number;
  readonly mcpServers: number;
  readonly contextStoreMounts: ExpertDefinition["contextStoreMounts"];
  readonly usesApproval: boolean;
  readonly icon: Icon;
  readonly persisted?: ExpertDefinition | undefined;
};

export type ExpertDraft = Omit<ExpertRecord, "icon"> & { readonly tagInput: string };

export const initialExperts: readonly ExpertRecord[] = [
  {
    id: "market-research-analyst",
    name: "Market Research Analyst",
    description: "Analyzes market trends and consumer insights.",
    tags: ["research", "strategy"],
    version: "1.2.0",
    scope: "personal",
    instructions:
      "You are a Market Research Analyst. Turn market data and signals into clear, evidence-based insights and recommendations. Clarify the objective, audience, time horizon, and constraints before you begin.",
    model: { modelName: "gpt-4.1" },
    skills: 2,
    tools: 3,
    mcpServers: 1,
    contextStoreMounts: [],
    usesApproval: true,
    icon: User,
  },
  {
    id: "data-engineer",
    name: "Data Engineer",
    description: "Builds and maintains data pipelines and infrastructure.",
    tags: ["data", "engineering"],
    version: "1.0.0",
    scope: "personal",
    instructions: "Build reliable, observable data systems with clear ownership and verification.",
    model: { modelName: "gpt-4.1" },
    skills: 1,
    tools: 2,
    mcpServers: 1,
    contextStoreMounts: [],
    usesApproval: false,
    icon: TerminalWindow,
  },
  {
    id: "customer-support-expert",
    name: "Customer Support Expert",
    description: "Provides customer support and resolves issues.",
    tags: ["support", "customer experience"],
    version: "1.0.0",
    scope: "personal",
    instructions: "Resolve customer issues clearly, accurately, and with empathy.",
    model: { modelName: "gpt-4.1" },
    skills: 1,
    tools: 2,
    mcpServers: 0,
    contextStoreMounts: [],
    usesApproval: false,
    icon: Robot,
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reviews code for quality, security, and best practices.",
    tags: ["engineering", "quality"],
    version: "1.1.0",
    scope: "organization",
    instructions: "Review changes for correctness, security, maintainability, and test coverage.",
    model: { modelName: "gpt-4.1" },
    skills: 2,
    tools: 3,
    mcpServers: 1,
    contextStoreMounts: [],
    usesApproval: true,
    icon: TerminalWindow,
  },
];

export const emptyDraft = (): ExpertDraft => ({
  id: "",
  name: "",
  description: "",
  tags: [],
  version: "0.1.0",
  scope: "personal",
  instructions: "",
  model: null,
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
    skills: definition.skills.length,
    tools: definition.toolIds.length,
    mcpServers: definition.mcpServers.length,
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
    scope: expert.scope === "organization" ? "organization" : "personal",
    instructions: expert.instructions || undefined,
    model: expert.model,
    skills: existing?.skills ?? [],
    mcpServers: existing?.mcpServers ?? [],
    toolIds: existing?.toolIds ?? [],
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
  { id: "tools", label: "Tools", icon: Wrench },
  { id: "context-stores", label: "Context stores", icon: Database },
] as const satisfies readonly {
  readonly id: StudioView;
  readonly label: string;
  readonly icon: Icon;
}[];

export const studioLabels = {
  experts: "Experts",
  teams: "Expert teams",
  tools: "Tools",
  "context-stores": "Context stores",
} satisfies Record<Exclude<StudioView, "overview">, string>;

export const studioDescriptions = {
  experts: "Individuals that perform specialized work in your missions.",
  teams: "Groups of experts that work together toward a mission.",
  tools: "Reusable tools and capabilities used by experts and teams.",
  "context-stores": "Reusable knowledge sources mounted by experts.",
} satisfies Record<Exclude<StudioView, "overview">, string>;

export const collectionAssets = {
  experts: initialExperts,
  teams: [
    {
      name: "Growth Intelligence Team",
      description: "Researches growth opportunities and market signals.",
    },
    { name: "Data Platform Team", description: "Designs and operates data systems and pipelines." },
  ],
  tools: [
    { name: "Web Search", description: "Search the web for real-time information." },
    { name: "Data Warehouse", description: "Query and analyze structured data at scale." },
  ],
  "context-stores": [],
} satisfies Record<
  Exclude<StudioView, "overview">,
  readonly { name: string; description: string }[]
>;
