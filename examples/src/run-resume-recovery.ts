/**
 * Resume recovery example: demonstrates crash recovery with session persistence.
 *
 * This example simulates a process crash mid-workflow and shows how `app.resume()`
 * recovers the execution state and runtime session.
 *
 * ## Quick start
 *
 * ```bash
 * # 1. Start (runs the first turn, then pauses at a check point)
 * pnpm --filter @pragma/examples dev src/run-resume-recovery.ts
 *
 * # 2. "Crash" (just exit the process — it already stopped at the checkpoint)
 *
 * # 3. Resume with the workflowRunId printed in step 1
 * pnpm --filter @pragma/examples dev src/run-resume-recovery.ts --workflow-run-id <id>
 * ```
 *
 * ## What happens under the hood
 *
 * 1. **First run**: Agent answers the first question → hits a human-task checkpoint
 *    → session is synced to an archive → process exits (simulating crash).
 *
 * 2. **Second run**: `app.resume(workflowRunId)` restores the workflow tree,
 *    recovers expired task leases, restores the runtime session from archive,
 *    and dispatches the pending human task. After responding to it, the agent
 *    answers the second question with full conversation context.
 */

import { cp, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import {
  createAgentLauncher,
  createPragma,
  createRuntimeRegistry,
  defineAgent,
  defineFlow,
  defineHumanTask,
  defineTask,
} from "@pragma/core";
import type {
  RuntimeSessionRestoreHandler,
  RuntimeSessionStorageContext,
  RuntimeSessionSyncCallback,
} from "@pragma/core";
import { createPiRuntime } from "@pragma/runtime-pi";

import { createExpertAgentModelsConfig, formatModelConfig, readExampleModelConfig } from "./harness/model-config.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { exitIfRuntimeUnavailable } from "./harness/runtime-availability.ts";

// ---------------------------------------------------------------------------
// Bootstrap
// ---------------------------------------------------------------------------

loadExamplesEnv();
const workflowRunId = readStringOption("--workflow-run-id");
const isResume = workflowRunId !== undefined;

const exampleRoot = resolve(defaultWorkspaceRoot, "resume-recovery-example");
const pragmaHome = join(exampleRoot, "pragma-home");
const archiveRoot = join(exampleRoot, "archive");
const workspace = join(exampleRoot, isResume ? "workspace-resumed" : "workspace-fresh");

await ensureWorkspaceDir(workspace);
await mkdir(archiveRoot, { recursive: true });

// ---------------------------------------------------------------------------
// Session persistence (sync / restore)
// ---------------------------------------------------------------------------

const archiveDir = (ctx: RuntimeSessionStorageContext): string =>
  join(archiveRoot, encodeURIComponent(ctx.runtimeSession.id));

const syncSession: RuntimeSessionSyncCallback = async (ctx) => {
  const dest = archiveDir(ctx);
  await rm(dest, { recursive: true, force: true });
  await cp(ctx.sessionDir, dest, { recursive: true });
  console.log(`[persist] session synced → ${dest}`);
};

const restoreSession: RuntimeSessionRestoreHandler = async (ctx) => {
  const src = archiveDir(ctx);
  await rm(ctx.sessionDir, { recursive: true, force: true });
  await mkdir(ctx.sessionDir, { recursive: true });
  await cp(src, ctx.sessionDir, { recursive: true });
  console.log(`[persist] session restored ← ${src}`);
};

// ---------------------------------------------------------------------------
// Runtime & App
// ---------------------------------------------------------------------------

const runtime = createPiRuntime({
  sessionSyncCallback: syncSession,
  sessionRestoreHandler: restoreSession,
});
await exitIfRuntimeUnavailable(runtime);

const app = createPragma({
  pragmaHome,
  runtimes: createRuntimeRegistry({ defaultRuntime: "pi", runtimes: [runtime] }),
});

// ---------------------------------------------------------------------------
// Agent & Launcher
// ---------------------------------------------------------------------------

const modelConfig = readExampleModelConfig();
const models = createExpertAgentModelsConfig(modelConfig);

const memoryAgent = await defineAgent({
  id: "memory-expert",
  name: "Memory Expert",
  description: "Remembers facts across a resumed workflow using session persistence.",
  tags: ["example", "resume", "session-persistence"],
  version: "1.0.0",
  scope: "local-test",
  workspace,
  pragmaHome,
  models,
  instructions: [
    "你是一个记忆测试 Agent。",
    "一轮对话中记住用户告诉你的所有信息。",
    "后续对话中用户要求回忆时，引用之前对话中的准确信息。",
    "如果记不清，如实说明，不要编造。",
  ].join("\n"),
});

const launcher = createAgentLauncher({
  agents: [memoryAgent],
  defaultSessionPolicy: "reuse_by_agent",
});

// ---------------------------------------------------------------------------
// Flow: two agent turns separated by a checkpoint (simulated crash boundary)
// ---------------------------------------------------------------------------

const flow = defineFlow({
  id: "resume-recovery-flow",
  version: "1.0.0",
  result: ({ state }) => ({
    first: state.results["turn1"],
    second: state.results["turn2"],
  }),
});

/** Launch the agent for a single turn inside the flow. */
function createTurn(id: string, task: string) {
  return defineTask({
    id,
    version: "1.0.0",
    children: [memoryAgent],
    async handler({ execution }) {
      const result = await launcher.tool.call(
        { agentId: memoryAgent.id, task, sessionPolicy: "reuse_by_agent", runtime: "pi" },
        undefined,
        { workflowExecution: execution },
      );
      if (result.isError) throw new Error(result.text);
      return result.text;
    },
  });
}

const turn1 = flow.use(
  "turn1",
  createTurn(
    "remember",
    "请记住：项目代号是 'phoenix-resume'，部署区域是 us-west-4，密钥指纹是 SHA256:ab12...ff。",
  ),
  {
    reduce: ({ state, output }) => {
      state.results["turn1"] = output;
    },
  },
);

const checkpoint = flow.use(
  "checkpoint",
  defineHumanTask({
    id: "simulated-crash",
    version: "1.0.0",
    request: {
      kind: "manual_intervention",
      title: "Simulated crash recovery",
      prompt: [
        "此时模拟进程崩溃。",
        "记录上面打印的 workflowRunId，退出当前进程，",
        "然后用 --workflow-run-id 重新启动以测试恢复。",
      ].join(" "),
    },
  }),
);

const turn2 = flow.use(
  "turn2",
  createTurn(
    "recall",
    [
      "请基于我们的对话历史（不要编造），回答以下问题：",
      "1. 项目代号是什么？",
      "2. 部署区域是什么？",
      "3. 密钥指纹是什么？",
    ].join("\n"),
  ),
  {
    reduce: ({ state, output }) => {
      state.results["turn2"] = output;
    },
  },
);

flow.compose(({ start, end }) =>
  start(turn1).next(checkpoint).next(turn2).next(end()),
);

// ---------------------------------------------------------------------------
// Execute
// ---------------------------------------------------------------------------

try {
  console.log("Resume Recovery Example");
  console.log(`- model: ${formatModelConfig(modelConfig)}`);
  console.log(`- workspace: ${workspace}`);
  console.log(`- mode: ${isResume ? "RESUME (recovering from checkpoint)" : "FRESH (first run)"}`);
  console.log("");

  if (!isResume) {
    // --- First run: start fresh, run until the checkpoint pauses the flow ---
    console.log("▶ Starting first turn (agent will remember facts)...");
    console.log("");

    const handle = await app.start(flow, { input: {} });

    for await (const event of handle.events) {
      if (event.sourceType !== "human.requested") continue;

      console.log("");
      console.log("⏸  Flow paused at checkpoint (simulated crash).");
      console.log(`   workflowRunId: ${handle.workflowRunId}`);
      console.log("");
      console.log("   Resume with:");
      console.log(`   pnpm --filter @pragma/examples dev src/run-resume-recovery.ts --workflow-run-id ${handle.workflowRunId}`);
      console.log("");
      break;
    }
  } else {
    // --- Second run: resume the workflow from the checkpoint ---
    console.log(`▶ Resuming workflow: ${workflowRunId}`);
    console.log("");

    const handle = await app.resume(flow, { workflowRunId });

    // Respond to the pending human interaction to continue past the checkpoint
    const pending = (await app.stateManager.listHumanInteractions(workflowRunId)).find(
      (i) => i.status === "pending",
    );

    if (pending !== undefined) {
      console.log("▶ Responding to checkpoint to continue...");
      await app.taskManager.respondToHumanInteraction({
        interactionId: pending.id,
        response: { decision: "continued" },
      });
    }

    console.log("▶ Running second turn (agent will recall from context)...");
    console.log("");

    const result = await handle.result;

    console.log("=== Final result ===");
    console.log(JSON.stringify(result.output, null, 2));
    console.log("");

    const tree = await app.runs.getTree(workflowRunId);
    console.log("=== Workflow tree ===");
    console.log(JSON.stringify(tree, null, 2));
  }
} finally {
  launcher.dispose();
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function readStringOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
