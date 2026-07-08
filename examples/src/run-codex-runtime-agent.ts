import { cac } from "cac";

import {
  AGENTS_CONTEXT_ID,
  ContextSystem,
  ExpertAgent,
  HOST_CONTEXT_NAMESPACE,
  createCodexLocalRuntimeAdapter,
  createInMemoryContextStore,
  type CodexRuntimeApprovalPolicy,
  type CodexRuntimeSandboxMode,
  type RuntimeSessionRef,
} from "@pragma/core";

import {
  printAgentContextSummary,
  printRunHeader,
  printRunResult,
} from "./harness/expert-agent-example-utils.ts";
import { createExampleLoggerProvider } from "./harness/logger.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { printRunStream } from "./harness/stream-output.ts";

interface CodexRuntimeExampleCliOptions {
  readonly turns: readonly string[];
  readonly model: string | undefined;
  readonly runtimeSessionId: string | undefined;
  readonly systemSessionId: string | undefined;
  readonly sandboxMode: CodexRuntimeSandboxMode | undefined;
  readonly approvalPolicy: CodexRuntimeApprovalPolicy | undefined;
}

const defaultQuery = [
  "执行一次 Codex local runtime 综合检查：",
  "1. 先根据启动上下文说明 Pragma 的模块边界原则，并点名 codex-runtime-runbook.md。",
  "2. 必须使用只读本地工具调用检查当前目录和仓库 package.json，例如运行 pwd 和 ls -la ../package.json。",
  "3. 最后用三条项目符号总结：context 是否可见、工具调用是否发生、当前 runtime 类型是什么。",
].join("\n");

loadExamplesEnv();

const cli = readCodexRuntimeExampleCli();
const workspace = defaultWorkspaceRoot;

await ensureWorkspaceDir(workspace);

const loggerProvider = createExampleLoggerProvider();
const contextSystem = createCodexRuntimeExampleContextSystem();
const agent = await ExpertAgent.create({
  id: "codex-runtime-example-expert",
  name: "Codex Runtime Example Expert",
  description:
    "Demonstrates running an ExpertAgent through the local Codex runtime with context and Codex tool events.",
  instructions: [
    "You are an ExpertAgent running through Pragma's Codex local runtime adapter.",
    "Answer concisely and mention concrete files or commands only when useful.",
    "When the task asks for a local check, use Codex's read-only local tools before answering.",
    "Use the always-on context as reference material and cite context IDs when they are relevant.",
  ].join("\n"),
  tags: ["example", "codex-runtime"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  contextSystem,
  loggerProvider,
});

const runtime = createCodexLocalRuntimeAdapter({
  loggerProvider,
  defaultModelName: cli.model,
  sandboxMode: cli.sandboxMode,
  approvalPolicy: cli.approvalPolicy,
});
const runtimeSession = createRuntimeSessionRef(cli.runtimeSessionId);
const session = await runtime.createSession({
  agent,
  ...(cli.systemSessionId === undefined ? {} : { systemSessionId: cli.systemSessionId }),
  ...(runtimeSession === undefined ? {} : { runtimeSession }),
});

try {
  const sessionInfo = session.info();

  await printAgentContextSummary(agent);

  console.log("Codex runtime session:");
  console.log(`- systemSessionId: ${sessionInfo.systemSessionId}`);
  console.log(`- runtimeSessionId: ${sessionInfo.runtimeSession.id}`);
  console.log(`- runtime: ${sessionInfo.runtime.displayName} (${sessionInfo.runtime.id})`);
  console.log(`- model: ${cli.model ?? "Codex config default"}`);
  console.log(`- sandbox: ${cli.sandboxMode ?? "Codex config default"}`);
  console.log(`- approvalPolicy: ${cli.approvalPolicy ?? "Codex config default"}`);
  console.log("");

  for (const [index, query] of cli.turns.entries()) {
    console.log(`Turn ${index + 1}/${cli.turns.length}`);
    printRunHeader(agent, cli.model ?? "Codex config default", query);
    const run = session.submit({
      query,
      ...(cli.model === undefined ? {} : { modelName: cli.model }),
    });

    await printRunStream(run);

    const result = await run.result;
    printRunResult(result.runId);
    console.log("");
  }
} finally {
  await session.abort();
}

function createCodexRuntimeExampleContextSystem(): ContextSystem {
  const contextSystem = new ContextSystem();

  contextSystem.register({
    namespace: HOST_CONTEXT_NAMESPACE,
    store: createInMemoryContextStore({
      context: [
        {
          id: AGENTS_CONTEXT_ID,
          content: [
            "# Codex Runtime Example Context",
            "",
            "Pragma is a multi-expert Agent orchestration platform.",
            "The core module boundary is apps/server -> packages/server -> packages/core -> packages/shared.",
            "apps/web must use @pragma/client and must not import @pragma/server or @pragma/core.",
            "packages/shared must stay runtime-neutral and must not import Node APIs.",
            "Codex local runtime should surface commandExecution and fileChange items as runtime tool stream events.",
          ].join("\n"),
          metadata: {
            description: "Always-on Codex runtime example context.",
            trigger: "always_on",
            trustLevel: "workspace",
            sensitivity: "internal",
          },
        },
        {
          id: "codex-runtime-runbook.md",
          content: [
            "# Codex Runtime Runbook",
            "",
            "Use sandbox=read-only for inspection tasks.",
            "Use approvalPolicy=never for non-mutating example runs.",
            "A healthy run should show message events, usage, and tool events when the task requires local inspection.",
            "The expected visible tool event for shell inspection is commandExecution mapped to exec_command.",
          ].join("\n"),
          metadata: {
            description: "Runbook for validating Codex runtime logs.",
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

function readCodexRuntimeExampleCli(): CodexRuntimeExampleCliOptions {
  const cli = cac("pragma-example-codex-runtime");

  cli
    .command("[query...]", "Task query to send to the Codex-backed ExpertAgent.")
    .option("--turn <query>", "Task query to submit. Repeat this option for multi-turn tests.")
    .option("--model <model>", "Codex model name to pass to thread/start and turn/start.")
    .option("--runtime-session-id <id>", "Resume an existing Codex runtime thread id.")
    .option("--system-session-id <id>", "Use a fixed Pragma system session id.")
    .option(
      "--sandbox <mode>",
      "Codex sandbox mode: read-only, workspace-write, or danger-full-access.",
    )
    .option(
      "--approval-policy <policy>",
      "Codex approval policy: untrusted, on-request, or never.",
    );
  cli.help();

  const parsed = cli.parse();

  if (parsed.options.help === true || parsed.options.version === true) {
    process.exit(0);
  }

  return {
    turns: readTurns(parsed.args, parsed.options.turn),
    model: readStringOption(parsed.options.model),
    runtimeSessionId: readStringOption(parsed.options.runtimeSessionId),
    systemSessionId: readStringOption(parsed.options.systemSessionId),
    sandboxMode: readSandboxModeOption(parsed.options.sandbox),
    approvalPolicy: readApprovalPolicyOption(parsed.options.approvalPolicy),
  };
}

function createRuntimeSessionRef(
  runtimeSessionId: string | undefined,
): RuntimeSessionRef | undefined {
  if (runtimeSessionId === undefined) {
    return undefined;
  }

  return {
    type: "codex-local",
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

function readSandboxModeOption(value: unknown): CodexRuntimeSandboxMode | undefined {
  const option = readStringOption(value);

  if (option === undefined) {
    return undefined;
  }

  if (option === "read-only" || option === "workspace-write" || option === "danger-full-access") {
    return option;
  }

  throw new Error(`Unsupported Codex sandbox mode: ${option}`);
}

function readApprovalPolicyOption(value: unknown): CodexRuntimeApprovalPolicy | undefined {
  const option = readStringOption(value);

  if (option === undefined) {
    return undefined;
  }

  if (option === "untrusted" || option === "on-request" || option === "never") {
    return option;
  }

  throw new Error(`Unsupported Codex approval policy: ${option}`);
}

function readStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}
