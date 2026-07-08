import { cac } from "cac";

import {
  createAgentLauncher,
  createPragma,
  createRuntimeRegistry,
  defineAgent,
} from "@pragma/core";
import type { AgentLaunchSessionPolicy, RunTree } from "@pragma/core";
import { createCloudPiRuntimeAdapter } from "@pragma/runtime-pi";

import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";

const defaultQuery = [
  "请先调用 launch_agent 委派 code-explorer-agent 探索仓库中 Agent、Runtime、Loop 的关系。",
  "然后基于探索结果说明：多 Agent 委派为什么应该走 Workflow/StateManager，而不是 runtime 私有子会话。",
].join("\n");

loadExamplesEnv();

const cli = readAgentDelegationCli(defaultQuery);
const workspace = defaultWorkspaceRoot;
await ensureWorkspaceDir(workspace);

const modelConfig = readExampleModelConfig();
const models = createExpertAgentModelsConfig(modelConfig);
const runtime = createCloudPiRuntimeAdapter({
  descriptor: {
    id: "pi",
    displayName: "PI Runtime",
  },
});
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
  memory: false,
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
  memory: false,
  tools: [launcher.tool],
  instructions: [
    "你是负责方案整合的 Coding Agent。",
    "回答前必须先调用 launch_agent，把代码探索任务委派给 code-explorer-agent。",
    "委派任务必须自包含，说明要探索的文件范围和期望输出。",
    "最终回答要引用被委派 Agent 的发现，并说明父子 Workflow 的关系。",
  ].join("\n"),
});

try {
  console.log("Example config:");
  console.log(`- model: ${formatModelConfig(modelConfig)}`);
  console.log(`- workspace: ${workspace}`);
  console.log(`- sessionPolicy: ${cli.sessionPolicy}`);
  console.log("");

  const handle = await app.start(coder, {
    input: cli.query,
    runtime: "pi",
  });
  const result = await handle.result;
  const tree = await app.runs.getTree(handle.workflowRunId);

  console.log("Parent workflow:", handle.workflowRunId);
  console.log("Result:");
  console.log(result.output);
  console.log("");
  console.log("Workflow tree:");
  printRunTree(tree);
} finally {
  launcher.dispose();
}

interface AgentDelegationCli {
  readonly query: string;
  readonly sessionPolicy: AgentLaunchSessionPolicy;
}

function readAgentDelegationCli(defaultTask: string): AgentDelegationCli {
  const cli = cac("pragma-example-agent-delegation");

  cli
    .command("[query...]", "Task query to send to the Coding Agent.")
    .option(
      "--session-policy <policy>",
      "Delegated runtime session policy: fresh or reuse_by_agent.",
    );
  cli.help();

  const parsed = cli.parse();

  if (parsed.options.help === true || parsed.options.version === true) {
    process.exit(0);
  }

  return {
    query: readQueryArgument(parsed.args, defaultTask),
    sessionPolicy: readSessionPolicy(parsed.options.sessionPolicy),
  };
}

function readQueryArgument(args: readonly unknown[], defaultTask: string): string {
  const query = args
    .filter((arg): arg is string => typeof arg === "string")
    .join(" ")
    .trim();

  return query.length > 0 ? query : defaultTask;
}

function readSessionPolicy(value: unknown): AgentLaunchSessionPolicy {
  if (value === undefined) {
    return "fresh";
  }

  if (value === "fresh" || value === "reuse_by_agent") {
    return value;
  }

  throw new Error('Expected --session-policy to be "fresh" or "reuse_by_agent".');
}

function printRunTree(tree: RunTree | undefined, depth = 0): void {
  if (tree === undefined) {
    console.log("(run tree unavailable)");
    return;
  }

  const indent = "  ".repeat(depth);
  console.log(`${indent}- ${tree.workflow.loopId} ${tree.workflow.id} [${tree.workflow.status}]`);

  for (const child of tree.children) {
    printRunTree(child, depth + 1);
  }
}
