import { readFile } from "node:fs/promises";

import type { IExpertAgent } from "./expert-agent.ts";
import type {
  DocumentIndexer,
  ExpertAgentDocument,
  ExpertAgentDocumentSummary
} from "./document-indexer.ts";
import type { SubAgentDefinition } from "./sub-agent.ts";

export interface ExpertAgentContext {
  readonly systemPrompt: string;
  readonly agentsMd?: string | undefined;
  readonly documents: readonly ExpertAgentDocumentSummary[];
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
    const documentSummaries = documents.ok ? documents.value : [];

    const alwaysOnDocuments = await this.loadAlwaysOnDocuments(documentSummaries);
    const context: ExpertAgentContext = {
      systemPrompt: this.buildSystemPrompt({
        agentsMd,
        alwaysOnDocuments,
        documentError: documents.ok ? undefined : documents.error.message,
        documents: documentSummaries
      }),
      documents: documentSummaries
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
    readonly alwaysOnDocuments: readonly ExpertAgentDocument[];
    readonly documentError?: string | undefined;
    readonly documents: readonly ExpertAgentDocumentSummary[];
  }): string {
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
      context.documentError === undefined
        ? undefined
        : `Document store issue: ${context.documentError}`,
      formatDocumentsSection("Always-on documents", context.alwaysOnDocuments, true),
      formatDocumentsSection("Available documents", modelDecisionDocuments, false),
      formatSubAgentsSection(this.agent)
    ];

    return sections.filter((section) => section !== undefined && section.length > 0).join("\n\n");
  }

  private async loadAlwaysOnDocuments(
    documents: readonly ExpertAgentDocumentSummary[]
  ): Promise<readonly ExpertAgentDocument[]> {
    const alwaysOnDocuments = documents.filter(
      (document) => document.metadata.trigger === "always_on"
    );
    const loaded = await Promise.all(
      alwaysOnDocuments.map((document) => this.documentIndexer.read({ id: document.id }))
    );

    return loaded
      .filter((document) => document.ok)
      .map((document) => document.value);
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
  const lines = [
    `- ${subAgent.agentType}`,
    `  whenToUse: ${subAgent.whenToUse}`,
    formatToolsLine("tools", subAgent.tools),
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

function formatAgentsMdSection(agentsMd: string | undefined): string | undefined {
  if (agentsMd === undefined || agentsMd.length === 0) {
    return undefined;
  }

  return ["AGENTS.md instructions:", agentsMd].join("\n\n");
}

function formatDocumentsSection(
  title: string,
  documents: readonly (ExpertAgentDocument | ExpertAgentDocumentSummary)[],
  includeContent: boolean
): string | undefined {
  if (documents.length === 0) {
    return undefined;
  }

  const documentSections = documents.map((document) => {
    const headerLines = [
      `- ${document.id}`,
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

    if ("content" in document) {
      return [headerLines, "  content:", indent(document.content, "    ")].join("\n");
    }

    return headerLines;
  });

  return [title, ...documentSections].join("\n");
}

function indent(value: string, prefix: string): string {
  return value
    .split("\n")
    .map((line) => `${prefix}${line}`)
    .join("\n");
}
