import { ContextManager } from "./context-manager.ts";
import type { ExpertAgentContext } from "./context-manager.ts";
import { DocumentIndexer } from "../documents/document-indexer.ts";
import type {
  ExpertAgentDocument,
  ExpertAgentDocumentCreateInput,
  ExpertAgentDocumentDeleteInput,
  ExpertAgentDocumentResult,
  ExpertAgentDocumentSearchInput,
  ExpertAgentDocumentSearchMatch,
  ExpertAgentDocumentStore,
  ExpertAgentDocumentSummary,
  ExpertAgentDocumentUpdateInput,
  ExpertAgentDocumentReadInput,
} from "../documents/document-indexer.ts";
import { createDocumentTools } from "../documents/document-tools.ts";
import type { CreateDocumentToolsOptions, ExpertAgentDefaultTool } from "../documents/document-tools.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import type { SubAgentRegistry } from "../subagents/sub-agent.ts";

export type ExpertAgentSchemaVersion = "expertmesh.expert/v1";

export type ExpertAgentSkillPackageType = "builtin" | "registry" | "local";

export interface IExpertAgentMcpServer {
  readonly name: string;
  readonly command?: string;
  readonly args?: readonly string[];
  readonly env?: Record<string, string>;
  readonly url?: string;
  readonly timeout?: number;
  readonly token?: string;
  readonly allowTools?: readonly string[];
  readonly disallowTools?: readonly string[];
}

export interface IExpertAgentMcpConfig {
  readonly mcpServers: Record<string, IExpertAgentMcpServer>;
}

export interface IExpertAgentSkill {
  readonly type: ExpertAgentSkillPackageType;
  readonly name: string;
  readonly description: string;
  readonly path?: string;
  readonly baseDir?: string;
  readonly version?: string | null;
}

export interface IExpertAgentSkillsConfig {
  readonly skills: readonly IExpertAgentSkill[];
}

export interface IExpertAgentRunRequest<TInput = string> {
  readonly task: string;
  readonly input: TInput;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface IExpertAgentRunResult<TOutput = string> {
  readonly output: TOutput;
}

export type ExpertAgentRunFunction<TInput = string, TOutput = string> = (
  request: IExpertAgentRunRequest<TInput>,
) => Promise<IExpertAgentRunResult<TOutput>>;

export interface IExpertAgent {
  readonly schemaVersion: ExpertAgentSchemaVersion;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly scope: string;
  readonly workspace: string;
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly documents?: ExpertAgentDocumentStore | undefined;
  readonly subAgents?: SubAgentRegistry | undefined;
}

export type ExpertAgentOptions = IExpertAgent;

export class ExpertAgent implements IExpertAgent {
  readonly schemaVersion: ExpertAgentSchemaVersion;
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly tags: readonly string[];
  readonly version: string;
  readonly scope: string;
  readonly mcp: IExpertAgentMcpConfig | undefined;
  readonly skills: IExpertAgentSkillsConfig | undefined;
  readonly documents: ExpertAgentDocumentStore | undefined;
  readonly workspace: string;
  readonly subAgents: SubAgentRegistry | undefined;
  private readonly documentIndexer: DocumentIndexer;
  private readonly contextManager: ContextManager;

  constructor(options: ExpertAgentOptions) {
    this.schemaVersion = options.schemaVersion;
    this.id = options.id;
    this.displayName = options.displayName;
    this.description = options.description;
    this.tags = options.tags;
    this.version = options.version;
    this.scope = options.scope;
    this.mcp = options.mcp;
    this.skills = options.skills;
    this.documents = options.documents;
    this.workspace = options.workspace;
    this.subAgents = options.subAgents;
    this.documentIndexer = new DocumentIndexer({
      store: options.documents,
    });
    this.contextManager = new ContextManager({
      agent: this,
      documentIndexer: this.documentIndexer,
    });
  }

  async buildContext(): Promise<ExpertAgentContext> {
    return await this.contextManager.buildContext();
  }

  createDefaultTools(options: CreateDocumentToolsOptions = {}): readonly ExpertAgentDefaultTool[] {
    return createDocumentTools(this, options);
  }

  async listDocuments(
    context: ExpertAgentRunContext = {},
  ): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSummary[]>> {
    return await this.documentIndexer.index(context);
  }

  async readDocument(
    input: ExpertAgentDocumentReadInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    return await this.documentIndexer.read(input);
  }

  async searchDocuments(
    input: ExpertAgentDocumentSearchInput,
  ): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSearchMatch[]>> {
    return await this.documentIndexer.search(input);
  }

  async createDocument(
    input: ExpertAgentDocumentCreateInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    return await this.documentIndexer.create(input);
  }

  async updateDocument(
    input: ExpertAgentDocumentUpdateInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    return await this.documentIndexer.update(input);
  }

  async deleteDocument(
    input: ExpertAgentDocumentDeleteInput,
  ): Promise<ExpertAgentDocumentResult<{ readonly id: string }>> {
    return await this.documentIndexer.delete(input);
  }
}
