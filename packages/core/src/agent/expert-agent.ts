import { ContextManager } from "./context-manager.ts";
import type { ContextAssemblerOptions, ExpertAgentContext } from "./context-manager.ts";
import type { AgentMessageUsage } from "@pragma/shared";
import { ContextSystem } from "../context-system/context-system.ts";
import type {
  ExpertAgentContextAddInput,
  ExpertAgentContextItemEditInput,
  ExpertAgentContextItemEditResult,
  ExpertAgentContextItemDeleteResult,
  ExpertAgentContextItem,
  ExpertAgentContextItemDeleteInput,
  ExpertAgentContextResult,
  ExpertAgentContextItemSearchInput,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemReadInput,
  ContextIndex,
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
import type {
  ExpertAgentManagedTool,
  ExpertAgentToolApproval,
  ExpertAgentToolCallResult,
} from "../tools/managed-tool.ts";
import { mergeExpertAgentToolApprovals } from "../tools/managed-tool.ts";
import { PragmaPaths } from "../storage/pragma-paths.ts";

export type ExpertAgentSchemaVersion = "pragma.expert/v1" | undefined;

export type ExpertAgentSkillPackageType = "builtin" | "registry" | "local";

export interface IExpertAgentMcpToolInfo {
  readonly name: string;
  readonly description?: string | undefined;
  readonly inputSchema?: unknown;
  readonly outputSchema?: unknown;
}

export interface IExpertAgentInProcessMcpServer {
  readonly listTools: () => Promise<readonly IExpertAgentMcpToolInfo[]>;
  readonly callTool: (name: string, args: unknown, signal?: AbortSignal) => Promise<unknown>;
  readonly dispose?: (() => Promise<void>) | undefined;
}

interface IExpertAgentMcpServerBase {
  readonly name: string;
  readonly timeout?: number;
  readonly allowTools?: readonly string[];
  readonly disallowTools?: readonly string[];
  readonly toolApprovals?: Readonly<Record<string, ExpertAgentToolApproval>>;
}

export type IExpertAgentMcpServer =
  | (IExpertAgentMcpServerBase & {
      readonly transport: "stdio";
      readonly command: string;
      readonly args?: readonly string[];
      readonly env?: Record<string, string>;
    })
  | (IExpertAgentMcpServerBase & {
      readonly transport: "streamable-http" | "sse";
      readonly url: string;
      readonly token?: string;
    })
  | (IExpertAgentMcpServerBase & {
      readonly transport: "in-process";
      readonly inProcess: IExpertAgentInProcessMcpServer;
    });

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

export interface IExpertAgentModelsConfig {
  readonly default?: import("../runtime/runtime-adapter.ts").RuntimeModelSelection | undefined;
}

export interface IExpertAgentRunResult<TOutput = string> {
  readonly output: TOutput;
  readonly usage?: AgentMessageUsage | undefined;
}

export interface IExpertAgent {
  readonly schemaVersion?: ExpertAgentSchemaVersion;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions?: string | undefined;
  readonly tags: readonly string[];
  readonly version: string;
  readonly scope: string;
  /** Definition-level routing default. The resolved execution Runtime remains owned by RuntimeContextRecord. */
  readonly defaultRuntimeId?: string | undefined;
  readonly workspace: string;
  readonly pragmaHome: string;
  readonly mcp?: IExpertAgentMcpConfig | undefined;
  readonly skills?: IExpertAgentSkillsConfig | undefined;
  readonly models?: IExpertAgentModelsConfig | undefined;
  readonly contextSystem: ContextSystem;
  readonly tools?: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks?: ExpertAgentPluginHooks | undefined;
  readonly pluginLoadIssues?: readonly ExpertAgentPluginLoadIssue[] | undefined;
  readonly loggerProvider?: ExpertAgentLoggerProvider | undefined;
  readonly logger: ExpertAgentLogger;
}

export type ExpertOptions = Omit<
  IExpertAgent,
  "contextSystem" | "pluginLoadIssues" | "logger" | "pragmaHome"
> & {
  readonly contextSystem?: ContextSystem | undefined;
  readonly pragmaHome?: string | undefined;
};

export interface DefineExpertOptions extends ExpertOptions {
  readonly plugins?: readonly ExpertAgentPluginUse[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly pluginFailurePolicy?: "throw" | "collect" | undefined;
}

const defineExpertSymbol = Symbol("pragma.define-expert");

interface ExpertRuntimeOptions extends Omit<ExpertOptions, "pragmaHome"> {
  readonly pragmaHome: string;
  readonly pluginEntries?:
    | readonly (ExpertAgentPluginEntry | ExpertAgentPluginRegistration)[]
    | undefined;
  readonly pluginLoadIssues?: readonly ExpertAgentPluginLoadIssue[] | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

export class Expert implements IExpertAgent {
  readonly schemaVersion?: ExpertAgentSchemaVersion;
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly instructions: string | undefined;
  readonly tags: readonly string[];
  readonly version: string;
  readonly scope: string;
  readonly defaultRuntimeId: string | undefined;
  readonly mcp: IExpertAgentMcpConfig | undefined;
  readonly skills: IExpertAgentSkillsConfig | undefined;
  readonly models: IExpertAgentModelsConfig | undefined;
  readonly contextSystem: ContextSystem;
  readonly workspace: string;
  readonly pragmaHome: string;
  readonly tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] | undefined;
  readonly hooks: ExpertAgentPluginHooks | undefined;
  readonly pluginLoadIssues: readonly ExpertAgentPluginLoadIssue[] | undefined;
  readonly loggerProvider: ExpertAgentLoggerProvider;
  readonly logger: ExpertAgentLogger;
  private readonly contextManager: ContextManager;

  static async [defineExpertSymbol](options: DefineExpertOptions): Promise<Expert> {
    const pragmaHome = new PragmaPaths({ pragmaHome: options.pragmaHome, env: options.env }).root;
    const pluginUses = [...(options.plugins ?? [])];
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

    logger.info("Loading Expert plugins", {
      pluginCount: options.plugins?.length ?? 0,
    });

    const loaded = await loadExpertAgentPlugins({
      agentId: options.id,
      pragmaHome,
      sources: pluginSources,
      env: options.env,
      loggerProvider,
      pluginFailurePolicy: options.pluginFailurePolicy,
    });

    const agent = new Expert({
      ...options,
      pragmaHome,
      pluginEntries: [
        ...loaded.pluginEntries,
        ...pluginEntryUses.map((plugin) => ({
          entry: plugin.entry,
          ...(plugin.userConfig === undefined ? {} : { userConfig: plugin.userConfig }),
          ...(plugin.hostBindings === undefined ? {} : { hostBindings: plugin.hostBindings }),
        })),
      ],
      loggerProvider,
      pluginLoadIssues:
        options.pluginFailurePolicy === "collect" && loaded.issues.length > 0
          ? loaded.issues
          : undefined,
    });

    agent.logger.info("Expert created", {
      pluginCount: loaded.pluginEntries.length,
      pluginLoadIssueCount: loaded.issues.length,
    });

    return agent;
  }

  private constructor(options: ExpertRuntimeOptions) {
    const loggerProvider = options.loggerProvider ?? defaultExpertAgentLoggerProvider;
    const logger = createExpertAgentLogger(loggerProvider, {
      component: "expert-agent",
      agentId: options.id,
    });
    const contextSystem = options.contextSystem ?? new ContextSystem();
    const resolved = resolveExpertAgentPlugins({
      agent: {
        id: options.id,
        displayName: options.name,
        version: options.version,
      },
      host: {
        mcp: options.mcp,
        skills: options.skills,
        models: options.models,
        tools: options.tools,
        hooks: options.hooks,
      },
      contextSystem,
      pluginEntries: options.pluginEntries,
      workspaceRoot: options.workspace,
      loggerProvider,
      agentId: options.id,
    });

    this.schemaVersion = options.schemaVersion;
    this.id = options.id;
    this.name = options.name;
    this.description = options.description;
    this.instructions = options.instructions;
    this.tags = options.tags;
    this.version = options.version;
    this.scope = options.scope;
    this.defaultRuntimeId = options.defaultRuntimeId;
    this.mcp = resolved.mcp;
    this.skills = resolved.skills;
    this.models = resolved.models;
    this.contextSystem = contextSystem;
    this.workspace = options.workspace;
    this.pragmaHome = options.pragmaHome;
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
  ): Promise<ExpertAgentContextResult<ContextIndex>> {
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

  async editContext(
    input: ExpertAgentContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItemEditResult>> {
    return await this.contextSystem.edit(input);
  }

  async addContext(
    input: ExpertAgentContextAddInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    return await this.contextSystem.add(input);
  }

  async deleteContext(
    input: ExpertAgentContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItemDeleteResult>> {
    return await this.contextSystem.delete(input);
  }
}

export async function defineExpert(options: DefineExpertOptions): Promise<Expert> {
  return await Expert[defineExpertSymbol](options);
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
    const approval = mergeExpertAgentToolApprovals(tool.approval, approvalByTool.get(tool.name));

    return {
      ...tool,
      ...(approval === undefined ? {} : { approval }),
    };
  });
}
