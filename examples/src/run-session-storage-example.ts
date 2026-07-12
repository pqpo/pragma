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

import { createExpertAgentModelsConfig, readExampleModelConfig } from "./harness/model-config.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { exitIfRuntimeUnavailable } from "./harness/runtime-availability.ts";

loadExamplesEnv();
const workflowRunId = readOption("--workflow-run-id");
const exampleRoot = resolve(defaultWorkspaceRoot, "session-storage-example");
const pragmaHome = join(exampleRoot, "pragma-home");
const archiveRoot = join(exampleRoot, "archive");
const workspace = join(exampleRoot, workflowRunId === undefined ? "workspace-a" : "workspace-b");
await Promise.all([ensureWorkspaceDir(workspace), mkdir(archiveRoot, { recursive: true })]);

const syncSession: RuntimeSessionSyncCallback = async (context) => {
  const archive = archivePath(context);
  await rm(archive, { recursive: true, force: true });
  await cp(context.sessionDir, archive, { recursive: true });
  console.log(`[sync] ${context.sessionDir} -> ${archive}`);
};
const restoreSession: RuntimeSessionRestoreHandler = async (context) => {
  const archive = archivePath(context);
  await rm(context.sessionDir, { recursive: true, force: true });
  await mkdir(context.sessionDir, { recursive: true });
  await cp(archive, context.sessionDir, { recursive: true });
  console.log(`[restore] ${archive} -> ${context.sessionDir}`);
};
const runtime = createPiRuntime({
  sessionSyncCallback: syncSession,
  sessionRestoreHandler: restoreSession,
});
await exitIfRuntimeUnavailable(runtime);
const app = createPragma({
  pragmaHome,
  runtimes: createRuntimeRegistry({ defaultRuntime: "pi", runtimes: [runtime] }),
});
const agent = await defineAgent({
  id: "session-storage-expert",
  name: "Session Storage Expert",
  description: "Demonstrates Runtime Session restore through a resumed Root Workflow.",
  tags: ["example", "session-storage", "multi-turn", "resume"],
  version: "1.0.0",
  scope: "local-test",
  workspace,
  pragmaHome,
  models: createExpertAgentModelsConfig(readExampleModelConfig()),
});
const launcher = createAgentLauncher({ agents: [agent], defaultSessionPolicy: "reuse_by_agent" });
const flow = defineFlow({
  id: "session-storage-multi-turn",
  version: "1.0.0",
  result: ({ state }) => ({
    first: state.results["first"],
    second: state.results["second"],
  }),
});
const first = flow.use(
  "first",
  createLaunchTurn(
    "remember-turn",
    [
      "记住项目代号 mesh-session-sync。",
      "目标是验证进程重启后恢复同一个 Workflow-owned Runtime Session。",
    ].join("\n"),
  ),
  {
    reduce: ({ state, output }) => {
      state.results["first"] = output;
    },
  },
);
const pause = flow.use(
  "restart-checkpoint",
  defineHumanTask({
    id: "session-restart-checkpoint",
    version: "1.0.0",
    request: {
      kind: "manual_intervention",
      title: "Restart the example process",
      prompt: "Resume this Root Workflow in a new process before the second Agent turn.",
    },
  }),
);
const second = flow.use(
  "second",
  createLaunchTurn("recall-turn", "请说出上一轮保存的项目代号和恢复目标。"),
  {
    reduce: ({ state, output }) => {
      state.results["second"] = output;
    },
  },
);
flow.compose(({ start, end }) => start(first).next(pause).next(second).next(end()));

try {
  if (workflowRunId === undefined) {
    const handle = await app.start(flow, { input: {} });
    for await (const event of handle.events) {
      if (event.sourceType !== "human.requested") continue;
      console.log(`Workflow paused: ${handle.workflowRunId}`);
      console.log(
        `Resume in a new process:\npnpm --filter @pragma/examples dev src/run-session-storage-example.ts --workflow-run-id ${handle.workflowRunId}`,
      );
      break;
    }
  } else {
    const handle = await app.resume(flow, { workflowRunId });
    const pending = (await app.stateManager.listHumanInteractions(workflowRunId)).find(
      (interaction) => interaction.status === "pending",
    );
    if (pending !== undefined) {
      await app.taskManager.respondToHumanInteraction({
        interactionId: pending.id,
        response: { decision: "continued" },
      });
    }
    console.log(JSON.stringify((await handle.result).output, null, 2));
    console.log(JSON.stringify(await app.runs.getTree(workflowRunId), null, 2));
  }
} finally {
  launcher.dispose();
}

function createLaunchTurn(id: string, task: string) {
  return defineTask({
    id,
    version: "1.0.0",
    children: [agent],
    async handler({ execution }) {
      const result = await launcher.tool.call(
        { agentId: agent.id, task, sessionPolicy: "reuse_by_agent", runtime: "pi" },
        undefined,
        { workflowExecution: execution },
      );
      if (result.isError) throw new Error(result.text);
      return result.text;
    },
  });
}

function archivePath(context: RuntimeSessionStorageContext): string {
  return join(archiveRoot, encodeURIComponent(context.runtimeSession.id));
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}
