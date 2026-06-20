import { readFile } from "node:fs/promises";

import type { IExpertAgent } from "./expert-agent.ts";
import type { DocumentIndexer, IndexedDocument } from "./document-indexer.ts";
import { resolveSubAgentSystemPrompt } from "./sub-agent.ts";
import type { SubAgentDefinition } from "./sub-agent.ts";

export interface ExpertAgentContext {
  readonly systemPrompt: string;
  readonly agentsMd?: string | undefined;
  readonly documents: readonly IndexedDocument[];
}

export interface ContextManagerOptions {
  readonly agent: IExpertAgent;
  readonly documentIndexer: DocumentIndexer;
}

export class ContextManager {
  readonly agent: IExpertAgent;
  readonly documentIndexer: DocumentIndexer;

  constructor(options: ContextManagerOptions) {
    this.agent = options.agent;
    this.documentIndexer = options.documentIndexer;
  }

  async buildContext(): Promise<ExpertAgentContext> {
    const [documents, agentsMd] = await Promise.all([
      this.documentIndexer.index(),
      this.loadAgentsMd()
    ]);

    const context: ExpertAgentContext = {
      systemPrompt: this.buildSystemPrompt({ agentsMd, documents }),
      documents
    };

    if (agentsMd !== undefined) {
      return {
        ...context,
        agentsMd
      };
    }

    return context;
  }

  private async loadAgentsMd(): Promise<string | undefined> {
    if (this.agent.agentsMd === undefined || this.agent.agentsMd.length === 0) {
      return undefined;
    }

    try {
      return await readFile(this.agent.agentsMd, "utf8");
    } catch {
      return this.agent.agentsMd;
    }
  }

  private buildSystemPrompt(context: {
    readonly agentsMd?: string | undefined;
    readonly documents: readonly IndexedDocument[];
  }): string {
    const alwaysOnDocuments = context.documents.filter(
      (document) => document.metadata.trigger === "always_on"
    );

    const modelDecisionDocuments = context.documents.filter(
      (document) => document.metadata.trigger === "model_decision"
    );

    const sections = [
      `You are ${this.agent.displayName}.`,
      this.agent.description,
      `Expert ID: ${this.agent.id}`,
      `Scope: ${this.agent.scope}`,
      `Tags: ${this.agent.tags.join(", ")}`,
      formatAgentsMdSection(context.agentsMd),
      formatDocumentsSection("Always-on documents", alwaysOnDocuments, true),
      formatDocumentsSection("Available documents", modelDecisionDocuments, false),
      formatSubAgentsSection(this.agent)
    ];

    return sections.filter((section) => section !== undefined && section.length > 0).join("\n\n");
  }
}

function formatSubAgentsSection(agent: IExpertAgent): string | undefined {
  const subAgents = agent.subAgents?.agents ?? [];

  if (subAgents.length === 0) {
    return undefined;
  }

  return [
    "Available subAgents:",
    ...subAgents.map((subAgent) => formatSubAgent(agent, subAgent))
  ].join("\n");
}

function formatSubAgent(agent: IExpertAgent, subAgent: SubAgentDefinition): string {
  const prompt = resolveSubAgentSystemPrompt(subAgent, {
    parentAgentId: agent.id,
    parentDisplayName: agent.displayName,
    subAgentType: subAgent.agentType
  });

  const lines = [
    `- ${subAgent.agentType}`,
    `  whenToUse: ${subAgent.whenToUse}`,
    `  model: ${subAgent.model ?? "inherit"}`,
    formatToolsLine("tools", subAgent.tools),
    formatStringListLine("disallowedTools", subAgent.disallowedTools),
    formatNumberLine("maxTurns", subAgent.maxTurns),
    formatNumberLine("temperature", subAgent.temperature),
    subAgent.thinkingLevel === undefined ? undefined : `  thinkingLevel: ${subAgent.thinkingLevel}`,
    subAgent.contextBudget === undefined ? undefined : `  contextBudget: ${subAgent.contextBudget}`,
    "  systemPrompt:",
    indent(prompt, "    ")
  ];

  return lines.filter((line) => line !== undefined).join("\n");
}

function formatToolsLine(
  label: string,
  value: readonly string[] | "*" | undefined
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === "*") {
    return `  ${label}: *`;
  }

  return formatStringListLine(label, value);
}

function formatStringListLine(label: string, value: readonly string[] | undefined): string | undefined {
  if (value === undefined || value.length === 0) {
    return undefined;
  }

  return `  ${label}: ${value.join(", ")}`;
}

function formatNumberLine(label: string, value: number | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return `  ${label}: ${value}`;
}

function formatAgentsMdSection(agentsMd: string | undefined): string | undefined {
  if (agentsMd === undefined || agentsMd.length === 0) {
    return undefined;
  }

  return ["AGENTS.md instructions:", agentsMd].join("\n\n");
}

function formatDocumentsSection(
  title: string,
  documents: readonly IndexedDocument[],
  includeContent: boolean
): string | undefined {
  if (documents.length === 0) {
    return undefined;
  }

  const documentSections = documents.map((document) => {
    const headerLines = [
      `- ${document.path}`,
      document.metadata.description === undefined
        ? undefined
        : `  description: ${document.metadata.description}`,
      `  trigger: ${document.metadata.trigger}`
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    if (!includeContent) {
      return headerLines;
    }

    return [headerLines, "  content:", indent(document.content, "    ")].join("\n");
  });

  return [title, ...documentSections].join("\n");
}

function indent(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
