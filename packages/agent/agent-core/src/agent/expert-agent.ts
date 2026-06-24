import { ContextManager } from "./context-manager.ts";
import type { ContextAssemblerOptions, ExpertAgentContext } from "./context-manager.ts";
import type { AgentMessageUsage } from "@expertmesh/contracts";
import { ContextSystem } from "../context-system/context-system.ts";
import type {
  ExpertAgentContextAddInput,
  ExpertAgentContextItemDeleteResult,
  ExpertAgentContextItem,
  ExpertAgentContextItemDeleteInput,
  ExpertAgentContextResult,
  ExpertAgentContextItemSearchInput,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextStore,
  ExpertAgentContextItemSummary,
  ExpertAgentContextItemUpdateInput,
  ExpertAgentContextItemReadInput,
} from "../context-system/context-system.ts";
import { createContextTools } from "../context-system/context-tools.ts";
import type {
  CreateContextToolsOptions,
  ExpertAgentDefaultTool,
} from "../context-system/context-tools.ts";
import type {
  ExpertAgentPluginEntry,
  ExpertAgentPluginHooks,
} from "../plugins/expert-agent-plugin.ts";
import { resolveExpertAgentPlugins } from "../plugins/expert-agent-plugin.ts";
import type {
  ExpertAgentPluginLoadIssue,
  ExpertAgentPluginSource,
} from "../plugins/plugin-loader.ts";
import { loadExpertAgentPlugins } from "../plugins/plugin-loader.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import type { SubAgentRegistry } from "../subagents/sub-agent.ts";
import type { ExpertAgentManagedTool, ExpertAgentToolCallResult } from "../tools/managed-tool.ts";

export type ExpertAgentSchemaVersion = "expertmesh.expert/v1";

export type ExpertAgentSkillPackageType = "builtin" | "registry" | "local";

export interface IExpertAgentMcpToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
}

export interface IExpertAgentInProcessMcpServer {
  readonly listTools: () => Promise<readonly IExpertAgentMcpToolInfo[]>;
  readonly callTool: (name: string, args: unknown) => Promise<unknown>;
  readonly dispose?: (() => Promise<void>) | undefined;
}

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
  readonly inProcess?: IExpertAgentInProcessMcpServer | undefined;
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

export type ExpertAgentModelApi =
  | "anthropic-messages"
  | "google-generative-ai"
  | "openai-completions"
  | "openai-responses";

export interface IExpertAgentModelProviderConfig {
  readonly provider: string;
  readonly modelNames: readonly string[];
  readonly baseApi: string;
  readonly key: string;
  readonly api?: ExpertAgentModelApi | undefined;
}

export interface IExpertAgentModelsConfig {
  readonly defaultModelName?: string | undefined;
  readonly providers: readonly IExpertAgentModelProviderConfig[];
}

export interface IExpertAgentRunRequest<TInput = string> {
  readonly task: string;
  readonly input: TInput;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface IExpertAgentRunResult<TOutput = string> {
  readonly output: TOutput;
  readonly usage?: AgentMessageUsage | undefined;
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
  readonly models?: IExpertAgentModelsConfig | undefined;
  readonly context?: ExpertAgentContextStore | undefined;
  readonly subAgents?: SubAgentRegistry | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
  readonly pluginLoadIssues?: readonly ExpertAgentPluginLoadIssue[] | undefined;
}

export type ExpertAgentOptions = Omit<IExpertAgent, "pluginLoadIssues">;

export interface ExpertAgentCreateOptions extends ExpertAgentOptions {
  readonly plugins?: readonly ExpertAgentPluginSource[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

interface ExpertAgentRuntimeOptions extends ExpertAgentOptions {
  readonly pluginEntries?: readonly ExpertAgentPluginEntry[] | undefined;
  readonly pluginLoadIssues?: readonly ExpertAgentPluginLoadIssue[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

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
  readonly models: IExpertAgentModelsConfig | undefined;
  readonly context: ExpertAgentContextStore | undefined;
  readonly workspace: string;
  readonly subAgents: SubAgentRegistry | undefined;
  readonly tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks: ExpertAgentPluginHooks | undefined;
  readonly pluginLoadIssues: readonly ExpertAgentPluginLoadIssue[] | undefined;
  private readonly contextSystem: ContextSystem;
  private readonly contextManager: ContextManager;

  static async create(options: ExpertAgentCreateOptions): Promise<ExpertAgent> {
    const loaded = await loadExpertAgentPlugins({
      workspaceRoot: options.workspace,
      sources: options.plugins ?? [],
      env: options.env,
    });

    return new ExpertAgent({
      ...options,
      pluginEntries: loaded.pluginEntries,
      pluginLoadIssues: loaded.issues,
    });
  }

  private constructor(options: ExpertAgentRuntimeOptions) {
    const resolved = resolveExpertAgentPlugins({
      host: {
        mcp: options.mcp,
        skills: options.skills,
        models: options.models,
        context: options.context,
        subAgents: options.subAgents,
        tools: options.tools,
        hooks: options.hooks,
      },
      pluginEntries: options.pluginEntries,
      workspaceRoot: options.workspace,
      env: options.env,
    });

    this.schemaVersion = options.schemaVersion;
    this.id = options.id;
    this.displayName = options.displayName;
    this.description = options.description;
    this.tags = options.tags;
    this.version = options.version;
    this.scope = options.scope;
    this.mcp = resolved.mcp;
    this.skills = resolved.skills;
    this.models = resolved.models;
    this.context = options.context;
    this.workspace = options.workspace;
    this.subAgents = resolved.subAgents;
    this.tools = resolved.tools;
    this.hooks = resolved.hooks;
    this.pluginLoadIssues = options.pluginLoadIssues;
    this.contextSystem = new ContextSystem({
      stores: resolved.context,
    });
    this.contextManager = new ContextManager({
      agent: this,
      contextSystem: this.contextSystem,
    });
  }

  async buildContext(
    context: ExpertAgentRunContext = {},
    options: ContextAssemblerOptions = {},
  ): Promise<ExpertAgentContext> {
    return await this.contextManager.buildContext(context, options);
  }

  createDefaultTools(options: CreateContextToolsOptions = {}): readonly ExpertAgentDefaultTool[] {
    return createContextTools(this, options);
  }

  async listContext(
    context: ExpertAgentRunContext = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    return await this.contextSystem.index(context);
  }

  async readContext(
    input: ExpertAgentContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    return await this.contextSystem.read(input);
  }

  async searchContext(
    input: ExpertAgentContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    return await this.contextSystem.search(input);
  }

  async addContext(
    input: ExpertAgentContextAddInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    return await this.contextSystem.add(input);
  }

  async updateContext(
    input: ExpertAgentContextItemUpdateInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    return await this.contextSystem.update(input);
  }

  async deleteContext(
    input: ExpertAgentContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItemDeleteResult>> {
    return await this.contextSystem.delete(input);
  }
}
