import {
  AuthStorage,
  createAgentSession,
  createSyntheticSourceInfo,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
  Skill,
  ToolDefinition
} from "@earendil-works/pi-coding-agent";
import type {
  AgentLifecycle,
  ExpertAgentDefaultTool,
  ExpertAgent,
  ExpertAgentRunContext,
  IExpertAgentRunRequest,
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeRunRequest,
  RuntimeRunResult,
  SubAgentManagedTool,
  SubAgentRuntimeLaunchRequest
} from "@expertmesh/agent-core";
import { createSingleRunAgentLifecycle, createSubAgentTool } from "@expertmesh/agent-core";
import { dirname } from "node:path";

import { createMcpToolRegistry } from "./mcp-tools.ts";
import type { McpManagedTool } from "./mcp-tools.ts";

export interface CloudPiRuntimeAdapterOptions {
  readonly outputParser?: <TOutput>(text: string) => TOutput;
}

const defaultOutputParser = <TOutput>(text: string): TOutput => text as TOutput;

export function createCloudPiRuntimeAdapter<TInput = string, TOutput = string>(
  options: CloudPiRuntimeAdapterOptions = {}
): RuntimeAdapter<TInput, TOutput> {
  return {
    descriptor: {
      id: "cloud-pi-agent",
      kind: "cloud-pi-agent",
      displayName: "Cloud PI Agent"
    },
    async prepare({ agent }) {
      const authStorage = AuthStorage.create();
      const modelRegistry = ModelRegistry.create(authStorage);
      const cwd = agent.workspace;
      const context = await agent.buildContext();
      const loader = createResourceLoader(agent, cwd, context.systemPrompt);
      await loader.reload();
      const mcpToolRegistry = await createMcpToolRegistry(agent.mcp);
      let piSession: AgentSession | undefined;
      const lifecycle = createSingleRunAgentLifecycle<ExpertAgentRunContext>({
        abort: () => {
          void piSession?.abort();
        },
        cleanup: async () => {
          piSession?.dispose();
          await mcpToolRegistry.dispose();
        }
      });
      const customTools = createCustomTools({
        agent,
        authStorage,
        cwd,
        mcpTools: mcpToolRegistry.tools,
        modelRegistry,
        parentSystemPrompt: context.systemPrompt,
        lifecycle
      });

      const sessionOptions: CreateAgentSessionOptions = {
        cwd,
        authStorage,
        modelRegistry,
        resourceLoader: loader,
        sessionManager: SessionManager.inMemory()
      };

      if (customTools.length > 0) {
        sessionOptions.customTools = customTools;
      }

      try {
        const { session } = await createAgentSession(sessionOptions);
        piSession = session;

        return createPiRuntimeSession<TInput, TOutput>(
          session,
          options.outputParser ?? defaultOutputParser,
          lifecycle
        );
      } catch (error) {
        await mcpToolRegistry.dispose();
        throw error;
      }
    }
  };
}

function createResourceLoader(
  agent: ExpertAgent,
  cwd: string,
  systemPrompt: string
): DefaultResourceLoader {
  const skills = createPiSkills(agent);

  return new DefaultResourceLoader({
    cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [...base, systemPrompt],
    skillsOverride: (base) => ({
      skills: [...base.skills, ...skills],
      diagnostics: base.diagnostics
    })
  });
}

function createPiSkills(agent: ExpertAgent): Skill[] {
  return (agent.skills?.skills ?? [])
    .filter((skill) => skill.path !== undefined)
    .map((skill) => ({
      name: skill.name,
      description: skill.description,
      filePath: skill.path as string,
      baseDir: skill.baseDir ?? dirname(skill.path as string),
      sourceInfo: createSyntheticSourceInfo(skill.path as string, {
        source: skill.type,
        baseDir: skill.baseDir ?? dirname(skill.path as string)
      }),
      disableModelInvocation: false
    }));
}

function createCustomTools(options: {
  readonly agent: ExpertAgent;
  readonly authStorage: AuthStorage;
  readonly cwd: string;
  readonly mcpTools: readonly McpManagedTool[];
  readonly modelRegistry: ModelRegistry;
  readonly parentSystemPrompt: string;
  readonly lifecycle: AgentLifecycle<ExpertAgentRunContext>;
}): ToolDefinition[] {
  const subAgentTool = createSubAgentTool({
    agent: options.agent,
    parentSystemPrompt: options.parentSystemPrompt,
    launch: (request) =>
      launchPiSubAgent(request, {
        authStorage: options.authStorage,
        cwd: options.cwd,
        modelRegistry: options.modelRegistry
      })
  });
  const documentTools = options.agent.createDefaultTools({
    getContext: () => options.lifecycle.currentContext
  });

  return [
    ...createPiDefaultTools(documentTools),
    ...(subAgentTool === undefined ? [] : [createPiSubAgentTool(subAgentTool)]),
    ...createPiMcpTools(options.mcpTools)
  ];
}

function createPiDefaultTools(tools: readonly ExpertAgentDefaultTool[]): ToolDefinition[] {
  return tools.map((tool) => ({
    name: tool.name,
    label: tool.label,
    description: tool.description,
    promptSnippet: `${tool.name}: ${tool.description}`,
    parameters: normalizeInputSchema(tool.inputSchema),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      const result = await tool.call(params, signal);

      return {
        content: [
          {
            type: "text",
            text: result.text
          }
        ],
        isError: result.isError ?? false,
        details: result.details
      };
    }
  }));
}

function createPiSubAgentTool(subAgentTool: SubAgentManagedTool): ToolDefinition {
  return {
    name: subAgentTool.name,
    label: "Launch subAgent",
    description: subAgentTool.description,
    promptSnippet: "launch_subagent: delegate a focused task to a specialized subAgent",
    promptGuidelines: [
      "Use launch_subagent only when the subAgent's whenToUse matches the delegated task.",
      "Pass a self-contained task. Include the concrete files, constraints, and expected output."
    ],
    parameters: normalizeInputSchema(subAgentTool.inputSchema),
    executionMode: "parallel",
    async execute(_toolCallId, params, signal) {
      const result = await subAgentTool.call(params, signal);

      return {
        content: [
          {
            type: "text",
            text: result.text
          }
        ],
        isError: result.isError ?? false,
        details: result.details
      };
    }
  };
}

async function launchPiSubAgent(
  request: SubAgentRuntimeLaunchRequest,
  options: {
    readonly authStorage: AuthStorage;
    readonly cwd: string;
    readonly modelRegistry: ModelRegistry;
  }
) {
  const loader = new DefaultResourceLoader({
    cwd: options.cwd,
    agentDir: getAgentDir(),
    appendSystemPromptOverride: (base) => [
      ...base,
      request.parentSystemPrompt,
      request.systemPrompt
    ]
  });
  await loader.reload();

  const sessionOptions: CreateAgentSessionOptions = {
    cwd: options.cwd,
    authStorage: options.authStorage,
    modelRegistry: options.modelRegistry,
    resourceLoader: loader,
    sessionManager: SessionManager.inMemory()
  };

  const model = resolveSubAgentModel(request.definition.model, options);
  if (model !== undefined) {
    sessionOptions.model = model;
  }

  if (request.definition.tools !== undefined && request.definition.tools !== "*") {
    sessionOptions.tools = [...request.definition.tools];
  }

  if (request.definition.disallowedTools !== undefined) {
    sessionOptions.excludeTools = [...request.definition.disallowedTools];
  }

  const { session } = await createAgentSession(sessionOptions);
  const outputTextParts: string[] = [];
  const unsubscribe = session.subscribe((event) => {
    const delta = readAssistantTextDelta(event);

    if (delta !== undefined) {
      outputTextParts.push(delta);
    }
  });

  const abort = () => {
    void session.abort();
  };

  request.signal?.addEventListener("abort", abort, { once: true });

  try {
    await session.prompt(request.task);

    return {
      text: outputTextParts.join(""),
      details: {
        agentType: request.agentType,
        task: request.task,
        model: request.definition.model ?? "inherit"
      }
    };
  } finally {
    request.signal?.removeEventListener("abort", abort);
    unsubscribe();
    session.dispose();
  }
}

function resolveSubAgentModel(
  model: string | undefined,
  options: {
    readonly modelRegistry: ModelRegistry;
  }
): CreateAgentSessionOptions["model"] | undefined {
  if (model === undefined || model === "inherit") {
    return undefined;
  }

  return options.modelRegistry
    .getAll()
    .find(
      (candidate) =>
        candidate.id === model ||
        candidate.name === model ||
        `${candidate.provider}/${candidate.id}` === model
    );
}

function createPiMcpTools(mcpTools: readonly McpManagedTool[]): ToolDefinition[] {
  return mcpTools.map((mcpTool) => {
    const toolName = `mcp_${sanitizeToolName(mcpTool.serverId)}_${sanitizeToolName(mcpTool.name)}`;

    return {
      name: toolName,
      label: `MCP ${mcpTool.serverName}:${mcpTool.name}`,
      description: [
        mcpTool.description ?? `Call MCP tool ${mcpTool.name}.`,
        `Original MCP server: ${mcpTool.serverName}. Original tool: ${mcpTool.name}.`
      ].join("\n"),
      promptSnippet: `${toolName}: call ${mcpTool.name} from MCP server ${mcpTool.serverName}`,
      parameters: normalizeInputSchema(mcpTool.inputSchema),
      executionMode: "parallel",
      async execute(_toolCallId, params) {
        const result = await mcpTool.call(params, undefined);

        return {
          content: [
            {
              type: "text",
              text: formatMcpToolResult(result)
            }
          ],
          details: {
            server: mcpTool.serverName,
            tool: mcpTool.name,
            result
          }
        };
      }
    };
  });
}

function normalizeInputSchema(schema: unknown): ToolDefinition["parameters"] {
  if (isRecord(schema) && schema.type === "object") {
    return schema as ToolDefinition["parameters"];
  }

  return {
    type: "object",
    properties: {},
    additionalProperties: false
  } as ToolDefinition["parameters"];
}

function formatMcpToolResult(result: unknown): string {
  if (isRecord(result) && Array.isArray(result.content)) {
    const textParts = result.content
      .map((entry) => (isRecord(entry) && typeof entry.text === "string" ? entry.text : undefined))
      .filter((entry): entry is string => entry !== undefined);

    if (textParts.length > 0) {
      return textParts.join("\n");
    }
  }

  return typeof result === "string" ? result : JSON.stringify(result, null, 2);
}

function sanitizeToolName(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_]/g, "_").replace(/_+/g, "_");
  return sanitized.length === 0 ? "tool" : sanitized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function createPiRuntimeSession<TInput, TOutput>(
  session: AgentSession,
  outputParser: <TParsedOutput>(text: string) => TParsedOutput,
  lifecycle: AgentLifecycle<ExpertAgentRunContext>
): RuntimeAgentSession<TInput, TOutput> {
  return {
    state: () => lifecycle.state,
    async run(request) {
      return lifecycle.runOnce(request.request.context, async () => {
        const outputTextParts: string[] = [];
        const unsubscribe = session.subscribe((event) => {
          const delta = readAssistantTextDelta(event);

          if (delta !== undefined) {
            outputTextParts.push(delta);
          }
        });

        try {
          await session.prompt(formatExpertRunPrompt(request.request));

          return createRuntimeRunResult(request, outputParser<TOutput>(outputTextParts.join("")));
        } finally {
          unsubscribe();
        }
      });
    },
    async abort() {
      await lifecycle.abort();
    }
  };
}

function formatExpertRunPrompt<TInput>(request: IExpertAgentRunRequest<TInput>): string {
  return [
    request.task,
    "",
    "Input:",
    typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2)
  ].join("\n");
}

function createRuntimeRunResult<TInput, TOutput>(
  request: RuntimeRunRequest<TInput>,
  output: TOutput
): RuntimeRunResult<TOutput> {
  return {
    runId: request.invocation.runId,
    result: {
      output
    }
  };
}

function readAssistantTextDelta(event: AgentSessionEvent): string | undefined {
  if (event.type !== "message_update") {
    return undefined;
  }

  if (event.assistantMessageEvent.type === "text_delta") {
    return event.assistantMessageEvent.delta;
  }

  return undefined;
}
