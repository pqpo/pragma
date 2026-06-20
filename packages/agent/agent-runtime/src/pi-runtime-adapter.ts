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
  Skill
} from "@earendil-works/pi-coding-agent";
import type {
  ExpertAgent,
  IExpertAgentRunRequest,
  RuntimeAdapter,
  RuntimeAgentSession,
  RuntimeRunRequest,
  RuntimeRunResult
} from "@expertmesh/agent-core";
import { dirname } from "node:path";

export interface CloudPiRuntimeAdapterOptions {
  readonly agentDir?: string;
  readonly authStorage?: AuthStorage;
  readonly cwd?: string;
  readonly excludeTools?: readonly string[];
  readonly model?: CreateAgentSessionOptions["model"];
  readonly modelRegistry?: ModelRegistry;
  readonly sessionManager?: SessionManager;
  readonly tools?: readonly string[];
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
      assertSupportedByPiRuntime(agent);

      const agentDir = options.agentDir ?? getAgentDir();
      const authStorage = options.authStorage ?? AuthStorage.create();
      const modelRegistry = options.modelRegistry ?? ModelRegistry.create(authStorage);
      const cwd = options.cwd ?? agent.workspace ?? process.cwd();
      const context = await agent.contextManager.buildContext();
      const loader = createResourceLoader(agent, cwd, agentDir, context.systemPrompt);
      await loader.reload();

      const sessionOptions: CreateAgentSessionOptions = {
        cwd,
        agentDir,
        authStorage,
        modelRegistry,
        resourceLoader: loader,
        sessionManager: options.sessionManager ?? SessionManager.inMemory()
      };

      if (options.model !== undefined) {
        sessionOptions.model = options.model;
      }

      if (options.tools !== undefined) {
        sessionOptions.tools = [...options.tools];
      }

      if (options.excludeTools !== undefined) {
        sessionOptions.excludeTools = [...options.excludeTools];
      }

      const { session } = await createAgentSession(sessionOptions);

      return createPiRuntimeSession<TInput, TOutput>(
        session,
        options.outputParser ?? defaultOutputParser
      );
    }
  };
}

function assertSupportedByPiRuntime(agent: ExpertAgent): void {
  if (agent.mcp !== undefined && Object.keys(agent.mcp.mcpServers).length > 0) {
    throw new Error("cloud-pi-agent runtime does not support ExpertAgent MCP config yet.");
  }
}

function createResourceLoader(
  agent: ExpertAgent,
  cwd: string,
  agentDir: string,
  systemPrompt: string
): DefaultResourceLoader {
  const skills = createPiSkills(agent);

  return new DefaultResourceLoader({
    cwd,
    agentDir,
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

function createPiRuntimeSession<TInput, TOutput>(
  session: AgentSession,
  outputParser: <TParsedOutput>(text: string) => TParsedOutput
): RuntimeAgentSession<TInput, TOutput> {
  return {
    async run(request) {
      const outputTextParts: string[] = [];
      const unsubscribe = session.subscribe((event) => {
        const delta = readAssistantTextDelta(event);

        if (delta !== undefined) {
          outputTextParts.push(delta);
        }
      });

      try {
        await session.prompt(formatExpertRunPrompt(request.request));

        return createRuntimeRunResult(
          request,
          outputParser<TOutput>(outputTextParts.join(""))
        );
      } finally {
        unsubscribe();
      }
    },
    async dispose() {
      session.dispose();
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
