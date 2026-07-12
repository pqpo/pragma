import { cac } from "cac";

import {
  AGENTS_CONTEXT_ID,
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  createInMemoryContextStore,
  type RuntimeSessionRef,
} from "@pragma/core";
import {
  createClaudeCodeRuntime,
  type ClaudeCodeRuntimePermissionMode,
} from "@pragma/runtime-claude-code";

import {
  printAgentContextSummary,
  printRunHeader,
  printRunResult,
} from "./harness/expert-agent-example-utils.ts";
import { createExampleLoggerProvider } from "./harness/logger.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { selectRuntimeModel } from "./harness/runtime-model-selection.ts";
import { exitIfRuntimeUnavailable } from "./harness/runtime-availability.ts";
import { printRunStream } from "./harness/stream-output.ts";

interface ClaudeCodeRuntimeExampleCliOptions {
  readonly turns: readonly string[];
  readonly executablePath: string | undefined;
  readonly runtimeSessionId: string | undefined;
  readonly systemSessionId: string | undefined;
  readonly permissionMode: ClaudeCodeRuntimePermissionMode | undefined;
}

const defaultQuery = [
  "执行一次 Claude Code local runtime 综合检查：",
  "1. 先根据启动上下文说明 Pragma 的 runtime adapter 边界。",
  "2. 使用只读本地工具检查当前目录和仓库 package.json。",
  "3. 最后用三条项目符号总结：context 是否可见、工具调用是否发生、当前 runtime 类型是什么。",
].join("\n");
const defaultPermissionMode = "auto";

loadExamplesEnv();

const cli = readClaudeCodeRuntimeExampleCli();
const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const loggerProvider = createExampleLoggerProvider();
const contextSystem = createClaudeCodeRuntimeExampleContextSystem();
const agent = await ExpertAgent.create({
  id: "claude-code-runtime-example-expert",
  name: "Claude Code Runtime Example Expert",
  description:
    "Demonstrates running an ExpertAgent through the local Claude Code runtime with context and tool events.",
  instructions: [
    "You are an ExpertAgent running through Pragma's Claude Code local runtime adapter.",
    "Answer concisely and mention concrete files or commands only when useful.",
    "When the task asks for a local check, use Claude Code's read-only local tools before answering.",
    "Use the always-on context as reference material and cite context IDs when they are relevant.",
  ].join("\n"),
  tags: ["example", "claude-code-runtime"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  contextSystem,
  loggerProvider,
});

const runtimeProbe = createClaudeCodeRuntime({
  loggerProvider,
  ...(cli.executablePath === undefined ? {} : { executablePath: cli.executablePath }),
  ...(cli.permissionMode === undefined ? {} : { permissionMode: cli.permissionMode }),
});
await exitIfRuntimeUnavailable(runtimeProbe);
const detectedModels = await runtimeProbe.listModels?.();
if (detectedModels === undefined) {
  throw new Error("Claude Code runtime does not expose model discovery.");
}
const selection = await selectRuntimeModel({
  runtimeName: "Claude Code",
  models: detectedModels,
});
const runtime = createClaudeCodeRuntime({
  loggerProvider,
  defaultModelName: selection.modelName,
  defaultThinkingLevel: selection.thinkingLevel,
  listModels: async () => detectedModels,
  ...(cli.executablePath === undefined ? {} : { executablePath: cli.executablePath }),
  ...(cli.permissionMode === undefined ? {} : { permissionMode: cli.permissionMode }),
});
const runtimeSession = createRuntimeSessionRef(cli.runtimeSessionId);
const session = await runtime.createSession({
  agent,
  owner: { workflowRunId: "claude-code-runtime-example" },
  ...(cli.systemSessionId === undefined ? {} : { systemSessionId: cli.systemSessionId }),
  ...(runtimeSession === undefined ? {} : { runtimeSession }),
});

try {
  const sessionInfo = session.info();

  await printAgentContextSummary(agent);

  console.log("Claude Code runtime session:");
  console.log(`- systemSessionId: ${sessionInfo.systemSessionId}`);
  console.log(`- runtimeSessionId: ${sessionInfo.runtimeSession.id}`);
  console.log(`- runtime: ${sessionInfo.runtime.displayName} (${sessionInfo.runtime.id})`);
  console.log(`- executable: ${cli.executablePath ?? "claude"}`);
  console.log(`- model: ${selection.modelName ?? "Claude Code config default"}`);
  console.log(`- thinkingLevel: ${selection.thinkingLevel ?? "Claude Code config default"}`);
  console.log(`- permissionMode: ${cli.permissionMode ?? defaultPermissionMode}`);
  console.log("");

  for (const [index, query] of cli.turns.entries()) {
    console.log(`Turn ${index + 1}/${cli.turns.length}`);
    printRunHeader(agent, selection.modelName ?? "Claude Code config default", query);
    const run = session.submit({
      query,
      ...(selection.modelName === undefined ? {} : { modelName: selection.modelName }),
      ...(selection.thinkingLevel === undefined ? {} : { thinkingLevel: selection.thinkingLevel }),
    });

    await printRunStream(run);

    const result = await run.result;
    printRunResult(result.runId);
    console.log("");
  }
} finally {
  await session.abort();
}

function createClaudeCodeRuntimeExampleContextSystem(): ContextSystem {
  const contextSystem = new ContextSystem();

  contextSystem.register({
    namespace: HOST_CONTEXT_NAMESPACE,
    required: true,
    store: createInMemoryContextStore({
      context: [
        {
          id: AGENTS_CONTEXT_ID,
          content: [
            "# Claude Code Runtime Example Context",
            "",
            "Pragma is a multi-expert Agent orchestration platform.",
            "RuntimeAdapter is the boundary between ExpertAgent and concrete local or cloud runtimes.",
            "packages/core defines runtime contracts; packages/runtime/claude-code implements Claude Code integration.",
            "Concrete runtime packages must not depend on each other.",
          ].join("\n"),
          metadata: {
            description: "Always-on Claude Code runtime example context.",
            trigger: "always_on",
            trustLevel: "workspace",
            sensitivity: "internal",
            priority: "critical",
          },
        },
        {
          id: "claude-code-runtime-runbook.md",
          content: [
            "# Claude Code Runtime Runbook",
            "",
            "Use permissionMode=auto or plan for inspection tasks.",
            "A healthy run should show stream events, a runtime session id, and tool events when local inspection is required.",
            "Runtime availability is checked before session creation through runtime.canUse().",
          ].join("\n"),
          metadata: {
            description: "Runbook for validating Claude Code runtime logs.",
            trigger: "model_decision",
            trustLevel: "workspace",
            sensitivity: "internal",
          },
        },
      ],
    }),
  });

  return contextSystem;
}

function readClaudeCodeRuntimeExampleCli(): ClaudeCodeRuntimeExampleCliOptions {
  const cli = cac("pragma-example-claude-code-runtime");

  cli
    .command("[query...]", "Task query to send to the Claude Code-backed ExpertAgent.")
    .option("--turn <query>", "Task query to submit. Repeat this option for multi-turn tests.")
    .option("--executable <path>", "Claude Code executable path. Defaults to claude.")
    .option("--runtime-session-id <id>", "Resume an existing Claude Code runtime session id.")
    .option("--system-session-id <id>", "Use a fixed Pragma system session id.")
    .option("--permission-mode <mode>", "Claude Code permission mode.");
  cli.help();

  const parsed = cli.parse();

  if (parsed.options.help === true || parsed.options.version === true) {
    process.exit(0);
  }

  return {
    turns: readTurns(parsed.args, parsed.options.turn),
    executablePath: readStringOption(parsed.options.executable),
    runtimeSessionId: readStringOption(parsed.options.runtimeSessionId),
    systemSessionId: readStringOption(parsed.options.systemSessionId),
    permissionMode: readPermissionModeOption(parsed.options.permissionMode),
  };
}

function createRuntimeSessionRef(
  runtimeSessionId: string | undefined,
): RuntimeSessionRef | undefined {
  if (runtimeSessionId === undefined) {
    return undefined;
  }

  return {
    type: "claude-code-local",
    id: runtimeSessionId,
  };
}

function readTurns(args: readonly unknown[], turnOption: unknown): readonly string[] {
  const turns = readStringListOption(turnOption);

  if (turns.length > 0) {
    return turns;
  }

  const query = args
    .filter((arg): arg is string => typeof arg === "string")
    .join(" ")
    .trim();

  return [query.length > 0 ? query : defaultQuery];
}

function readStringListOption(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  const stringValue = readStringOption(value);

  return stringValue === undefined ? [] : [stringValue];
}

function readPermissionModeOption(value: unknown): ClaudeCodeRuntimePermissionMode | undefined {
  const option = readStringOption(value);

  if (option === undefined) {
    return undefined;
  }

  if (
    option === "default" ||
    option === "acceptEdits" ||
    option === "plan" ||
    option === "auto" ||
    option === "dontAsk" ||
    option === "bypassPermissions"
  ) {
    return option;
  }

  throw new Error(`Unsupported Claude Code permission mode: ${option}`);
}

function readStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}
