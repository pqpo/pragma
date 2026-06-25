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
  ExpertAgentPluginRegistration,
} from "../plugins/expert-agent-plugin.ts";
import { resolveExpertAgentPlugins } from "../plugins/expert-agent-plugin.ts";
import type { ExpertAgentLogger, ExpertAgentLoggerProvider } from "../logging/logger.ts";
import { createExpertAgentLogger, defaultExpertAgentLoggerProvider } from "../logging/logger.ts";
import type {
  ExpertAgentPluginLoadIssue,
  ExpertAgentPluginSource,
  ExpertAgentPluginUse,
} from "../plugins/plugin-loader.ts";
import { isExpertAgentPluginEntryUse, loadExpertAgentPlugins } from "../plugins/plugin-loader.ts";
import type { ExpertAgentRunContext } from "../runtime/run-context.ts";
import { createExpertAgentRunContext } from "../runtime/run-context.ts";
import type { SubAgentRegistry } from "../subagents/sub-agent.ts";
import type {
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
} from "../tools/managed-tool.ts";

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
  readonly contextSystem: ContextSystem;
  readonly subAgents?: SubAgentRegistry | undefined;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
  readonly pluginLoadIssues?: readonly ExpertAgentPluginLoadIssue[] | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly logger: ExpertAgentLogger;
}

export type ExpertAgentOptions = Omit<
  IExpertAgent,
  "contextSystem" | "pluginLoadIssues" | "logger"
> & {
  readonly contextSystem?: ContextSystem | undefined;
};

export interface ExpertAgentCreateOptions extends ExpertAgentOptions {
  readonly plugins?: readonly ExpertAgentPluginUse[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

interface ExpertAgentRuntimeOptions extends ExpertAgentOptions {
  readonly pluginEntries?:
    | readonly (ExpertAgentPluginEntry | ExpertAgentPluginRegistration)[]
    | undefined;
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
  readonly contextSystem: ContextSystem;
  readonly workspace: string;
  readonly subAgents: SubAgentRegistry | undefined;
  readonly tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks: ExpertAgentPluginHooks | undefined;
  readonly pluginLoadIssues: readonly ExpertAgentPluginLoadIssue[] | undefined;
  readonly loggerProvider: ExpertAgentLoggerProvider;
  readonly logger: ExpertAgentLogger;
  private readonly contextManager: ContextManager;

  static async create(options: ExpertAgentCreateOptions): Promise<ExpertAgent> {
    const pluginUses = options.plugins ?? [];
    const pluginSources: ExpertAgentPluginSource[] = [];
    const pluginEntryUses: Extract<
      ExpertAgentPluginUse,
      { readonly entry: ExpertAgentPluginEntry }
    >[] = [];

    for (const plugin of pluginUses) {
      if (isExpertAgentPluginEntryUse(plugin)) {
        pluginEntryUses.push(plugin);
      } else {
        pluginSources.push(plugin);
      }
    }
    const loggerProvider = options.loggerProvider ?? defaultExpertAgentLoggerProvider;
    const logger = createExpertAgentLogger(loggerProvider, {
      component: "expert-agent",
      agentId: options.id,
    });

    logger.info("Loading ExpertAgent plugins", {
      pluginCount: options.plugins?.length ?? 0,
    });

    const loaded = await loadExpertAgentPlugins({
      workspaceRoot: options.workspace,
      sources: pluginSources,
      env: options.env,
      loggerProvider,
    });

    const agent = new ExpertAgent({
      ...options,
      pluginEntries: [
        ...loaded.pluginEntries,
        ...pluginEntryUses.map((plugin) => ({
          entry: plugin.entry,
          ...(plugin.config === undefined ? {} : { config: plugin.config }),
        })),
      ],
      loggerProvider,
      pluginLoadIssues: loaded.issues,
    });

    agent.logger.info("ExpertAgent created", {
      pluginCount: loaded.pluginEntries.length,
      pluginLoadIssueCount: loaded.issues.length,
    });

    return agent;
  }

  private constructor(options: ExpertAgentRuntimeOptions) {
    const loggerProvider = options.loggerProvider ?? defaultExpertAgentLoggerProvider;
    const logger = createExpertAgentLogger(loggerProvider, {
      component: "expert-agent",
      agentId: options.id,
    });
    const contextSystem = options.contextSystem ?? new ContextSystem();
    const resolved = resolveExpertAgentPlugins({
      agent: {
        id: options.id,
        displayName: options.displayName,
        version: options.version,
      },
      host: {
        mcp: options.mcp,
        skills: options.skills,
        models: options.models,
        subAgents: options.subAgents,
        tools: options.tools,
        hooks: options.hooks,
      },
      contextSystem,
      pluginEntries: options.pluginEntries,
      workspaceRoot: options.workspace,
      env: options.env,
      loggerProvider,
      agentId: options.id,
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
    this.contextSystem = contextSystem;
    this.workspace = options.workspace;
    this.subAgents = resolved.subAgents;
    this.tools = applyToolApprovals(resolved.tools, resolved.toolApprovals);
    this.hooks = resolved.hooks;
    this.pluginLoadIssues = options.pluginLoadIssues;
    this.loggerProvider = loggerProvider;
    this.logger = logger;
    this.contextManager = new ContextManager({
      agent: this,
      contextSystem: this.contextSystem,
    });
  }

  async buildContext(
    context: ExpertAgentRunContext = createExpertAgentRunContext(),
    options: ContextAssemblerOptions = {},
  ): Promise<ExpertAgentContext> {
    return await this.contextManager.buildContext(createExpertAgentRunContext(context), options);
  }

  createDefaultTools(options: CreateContextToolsOptions = {}): readonly ExpertAgentDefaultTool[] {
    return createContextTools(this, options);
  }

  async listContext(
    context: ExpertAgentRunContext = createExpertAgentRunContext(),
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    return await this.contextSystem.index(createExpertAgentRunContext(context));
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

function applyToolApprovals(
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined,
  approvals:
    | readonly {
        readonly toolName: string;
        readonly approval: ExpertAgentToolApproval;
      }[]
    | undefined,
): readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined {
  if (tools === undefined) {
    return undefined;
  }

  if (approvals === undefined || approvals.length === 0) {
    return tools;
  }

  const approvalByTool = new Map(
    approvals.map((approval) => [approval.toolName, approval.approval]),
  );

  return tools.map((tool) => {
    const approval = approvalByTool.get(tool.name);

    return {
      ...tool,
      ...(approval === undefined ? {} : { approval }),
    };
  });
}
