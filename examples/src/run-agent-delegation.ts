import { cac } from "cac";

import {
  createAgentLauncher,
  createPragma,
  createRuntimeRegistry,
  defineAgent,
} from "@pragma/core";
import type {
  AgentLaunchSessionPolicy,
  RunTree,
  RuntimeSessionRef,
  RuntimeStreamEvent,
} from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";

import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { exitIfRuntimeUnavailable } from "./harness/runtime-availability.ts";
import { StreamEventPrinter } from "./harness/stream-output.ts";

const defaultTurns = [
  [
    "请先不要调用 launch_agent。",
    "请以 coding-agent 身份用两三句话介绍你自己、你的职责，以及你何时会委派 code-explorer-agent。",
  ].join("\n"),
  [
    "现在请调用 launch_agent 委派 code-explorer-agent 探索仓库中 Agent、Runtime、Directive 的关系。",
    "委派任务要聚焦关键文件、当前实现事实和可验证证据。",
  ].join("\n"),
  [
    "请基于前两轮对话和 code-explorer-agent 的探索结果做总结。",
    "说明：多 Agent 委派为什么应该走 Workflow/StateManager，而不是 runtime 私有子会话。",
    "请引用委派 Agent 的发现；除非缺少探索结果，否则这一轮不要再次委派。",
  ].join("\n"),
];

loadExamplesEnv();

const cli = readAgentDelegationCli(defaultTurns);
const workspace = defaultWorkspaceRoot;
await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const models = createExpertAgentModelsConfig(modelConfig);
const runtime = createPiRuntime({
  descriptor: {
    id: "pi",
    displayName: "PI Runtime",
  },
});
await exitIfRuntimeUnavailable(runtime);
const app = createPragma({
  runtimes: createRuntimeRegistry({
    defaultRuntime: "pi",
    runtimes: [runtime],
  }),
});

const explorer = await defineAgent({
  id: "code-explorer-agent",
  name: "Code Explorer Agent",
  description: "Explores repository structure and reports concise implementation findings.",
  tags: ["example", "exploration"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  models,
  instructions: [
    "你是专门做代码探索的 ExpertAgent。",
    "只做只读探索和事实归纳，不修改文件。",
    "输出必须包含关键文件、当前实现事实和建议的下一步。",
  ].join("\n"),
});

const launcher = createAgentLauncher({
  agents: [explorer],
  defaultSessionPolicy: cli.sessionPolicy,
});

const coder = await defineAgent({
  id: "coding-agent",
  name: "Coding Agent",
  description: "Coordinates implementation work and delegates focused repository exploration.",
  tags: ["example", "coding", "delegation"],
  version: "0.0.0",
  scope: "local-test",
  workspace,
  models,
  tools: [launcher.tool],
  instructions: [
    "你是负责方案整合的 Coding Agent。",
    "当用户明确要求代码探索或委派时，必须调用 launch_agent，把任务委派给 code-explorer-agent。",
    "如果用户明确要求不要委派，直接回答，不要调用 launch_agent。",
    "委派任务必须自包含，说明要探索的文件范围和期望输出。",
    "总结时优先使用当前多轮对话中的委派发现，并说明父子 Workflow 的关系。",
  ].join("\n"),
});

try {
  console.log("Example config:");
  console.log(`- model: ${formatModelConfig(modelConfig)}`);
  console.log(`- workspace: ${workspace}`);
  console.log(`- sessionPolicy: ${cli.sessionPolicy}`);
  console.log(`- turns: ${cli.turns.length}`);
  console.log("");

  let runtimeSession: RuntimeSessionRef | undefined;

  for (const [index, turn] of cli.turns.entries()) {
    console.log(`Turn ${index + 1}/${cli.turns.length}`);
    console.log("User:");
    console.log(turn);
    console.log("");

    const handle = await app.start(
      coder,
      runtimeSession === undefined
        ? {
            input: turn,
            runtime: "pi",
          }
        : {
            input: turn,
            runtime: "pi",
            runtimeSession,
          },
    );
    const stream = printAgentWorkflowStreams(handle.workflowRunId);
    const result = await handle.result;
    await stream;
    runtimeSession = result.runtimeSession;

    const tree = await app.runs.getTree(handle.workflowRunId);

    console.log("");
    console.log(`Turn ${index + 1} parent workflow: ${handle.workflowRunId}`);
    console.log("Turn result:");
    console.log(result.output);
    console.log("");
    console.log("Workflow tree:");
    printRunTree(tree);
    console.log("");
  }
} finally {
  launcher.dispose();
}

interface AgentDelegationCli {
  readonly turns: readonly string[];
  readonly sessionPolicy: AgentLaunchSessionPolicy;
}

function readAgentDelegationCli(defaultTurns: readonly string[]): AgentDelegationCli {
  const cli = cac("pragma-example-agent-delegation");

  cli
    .command("[query...]", "Optional single-turn query to send to the Coding Agent.")
    .option("--turn <query>", "Turn query to submit. Repeat this option for multi-turn tests.")
    .option("--session-policy <policy>", "Delegated runtime session policy (fresh).");
  cli.help();

  const parsed = cli.parse();

  if (parsed.options.help === true || parsed.options.version === true) {
    process.exit(0);
  }

  return {
    turns: readTurns(parsed.args, parsed.options.turn, defaultTurns),
    sessionPolicy: readSessionPolicy(parsed.options.sessionPolicy),
  };
}

function readTurns(
  args: readonly unknown[],
  turnOption: unknown,
  defaultTurns: readonly string[],
): readonly string[] {
  const turns = readStringListOption(turnOption);

  if (turns.length > 0) {
    return turns;
  }

  const query = args
    .filter((arg): arg is string => typeof arg === "string")
    .join(" ")
    .trim();

  return query.length > 0 ? [query] : defaultTurns;
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

function readStringOption(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();

  return trimmed.length > 0 ? trimmed : undefined;
}

function readSessionPolicy(value: unknown): AgentLaunchSessionPolicy {
  if (value === undefined) {
    return "fresh";
  }

  if (value === "fresh") {
    return value;
  }

  throw new Error('Expected --session-policy to be "fresh".');
}

function printRunTree(tree: RunTree | undefined, depth = 0): void {
  if (tree === undefined) {
    console.log("(run tree unavailable)");
    return;
  }

  const indent = "  ".repeat(depth);
  console.log(
    `${indent}- ${tree.workflow.directiveId} ${tree.workflow.id} [${tree.workflow.status}]`,
  );

  for (const child of tree.children) {
    printRunTree(child, depth + 1);
  }
}

async function printAgentWorkflowStreams(parentWorkflowRunId: string): Promise<void> {
  const childWorkflowRunIds = new Set<string>();
  const printers = new Map<string, StreamEventPrinter>();

  await seedChildWorkflowRunIds(parentWorkflowRunId, childWorkflowRunIds);
  console.log(`Main agent workflow: ${parentWorkflowRunId}`);

  for await (const event of app.runs.watch(parentWorkflowRunId, { recursive: true })) {
    if (event.parentWorkflowRunId === parentWorkflowRunId) {
      childWorkflowRunIds.add(event.workflowRunId);
    }

    const isMainWorkflow = event.workflowRunId === parentWorkflowRunId;
    const isDelegatedWorkflow = childWorkflowRunIds.has(event.workflowRunId);

    if (!isMainWorkflow && !isDelegatedWorkflow) {
      continue;
    }

    if (event.type === "workflow.started" && isDelegatedWorkflow) {
      console.log("");
      console.log(`Delegated agent workflow: ${event.workflowRunId}`);
      continue;
    }

    if (event.type === "workflow.completed") {
      printers.get(event.workflowRunId)?.finish();
      continue;
    }

    const streamEvent = readRuntimeStreamEvent(event);

    if (streamEvent === undefined) {
      continue;
    }

    const printer = getPrinter(printers, event.workflowRunId);
    printer.print(streamEvent);
  }

  for (const printer of printers.values()) {
    printer.finish();
  }
}

async function seedChildWorkflowRunIds(
  parentWorkflowRunId: string,
  childWorkflowRunIds: Set<string>,
): Promise<void> {
  const tree = await app.runs.getTree(parentWorkflowRunId);

  if (tree === undefined) {
    return;
  }

  for (const child of tree.children) {
    childWorkflowRunIds.add(child.workflow.id);
  }
}

function readRuntimeStreamEvent(event: {
  readonly type: string;
  readonly payload: unknown;
}): RuntimeStreamEvent | undefined {
  if (event.type !== "task.progress" && event.type !== "task.output.delta") {
    return undefined;
  }

  return isRuntimeStreamEvent(event.payload) ? event.payload : undefined;
}

function getPrinter(
  printers: Map<string, StreamEventPrinter>,
  workflowRunId: string,
): StreamEventPrinter {
  const existing = printers.get(workflowRunId);

  if (existing !== undefined) {
    return existing;
  }

  const printer = new StreamEventPrinter();
  printers.set(workflowRunId, printer);
  return printer;
}

function isRuntimeStreamEvent(value: unknown): value is RuntimeStreamEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "schemaVersion" in value &&
    value.schemaVersion === "pragma.stream/v1" &&
    "type" in value &&
    typeof value.type === "string" &&
    "payload" in value
  );
}
