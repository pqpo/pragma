import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ExpertAgent } from "@expertmesh/agent-core";
import type {
  RuntimeAgentSession,
  RuntimeSessionRestoreHandler,
  RuntimeSessionSyncCallback,
} from "@expertmesh/agent-core";
import { createCloudPiRuntimeAdapter } from "@expertmesh/agent-runtime";

import { printRunHeader, printRunResult } from "./harness/expert-agent-example-utils.ts";
import { createExampleLoggerProvider } from "./harness/logger.ts";
import {
  createExpertAgentModelsConfig,
  formatModelConfig,
  readExampleModelConfig,
} from "./harness/model-config.ts";
import { defaultWorkspaceRoot, ensureWorkspaceDir, loadExamplesEnv } from "./harness/paths.ts";
import { printRunStream } from "./harness/stream-output.ts";

const agentId = "session-storage-example-expert";
const firstTurn = [
  "请记住本轮会话的事实：",
  "项目代号是 mesh-session-sync，目标是验证 runtime session 可以同步到长期存储。",
  "回复时只确认你已记住。",
].join("\n");
const secondTurn = "请总结上轮会话里我让你记住的项目代号和目标。";

loadExamplesEnv();

const modelConfig = readExampleModelConfig();
const loggerProvider = createExampleLoggerProvider();
const exampleRoot = resolve(defaultWorkspaceRoot, "session-storage-example");
const firstWorkspace = join(exampleRoot, "workspace-a");
const secondWorkspace = join(exampleRoot, "workspace-b");
const longTermStorage = join(exampleRoot, "long-term-session-storage");

await rm(exampleRoot, { recursive: true, force: true });
await Promise.all([
  ensureWorkspaceDir(firstWorkspace),
  ensureWorkspaceDir(secondWorkspace),
  mkdir(longTermStorage, { recursive: true }),
]);

const syncSession: RuntimeSessionSyncCallback = async (context) => {
  const archiveDir = getArchivedSessionDir(context.runtimeSession.id);
  await mkdir(dirname(archiveDir), { recursive: true });
  await rm(archiveDir, { recursive: true, force: true });
  await cp(context.sessionDir, archiveDir, { recursive: true });
  console.log(
    `[sync] agent=${context.agentId} runtimeSession=${context.runtimeSession.id} workspace=${context.workspace}`,
  );
  console.log(`[sync] ${context.sessionDir} -> ${archiveDir}`);
};

const restoreSession: RuntimeSessionRestoreHandler = async (context) => {
  const archiveDir = getArchivedSessionDir(context.runtimeSession.id);
  await rm(context.sessionDir, { recursive: true, force: true });
  await mkdir(context.sessionDir, { recursive: true });
  await cp(archiveDir, context.sessionDir, { recursive: true });
  console.log(
    `[restore] agent=${context.agentId} runtimeSession=${context.runtimeSession.id} workspace=${context.workspace}`,
  );
  console.log(`[restore] ${archiveDir} -> ${context.sessionDir}`);
};

console.log("Session storage example:");
console.log(`- workspace A: ${firstWorkspace}`);
console.log(`- workspace B: ${secondWorkspace}`);
console.log(`- long-term storage: ${longTermStorage}`);
console.log("");

const firstAgent = await createExampleAgent(firstWorkspace);
const firstRuntime = createCloudPiRuntimeAdapter({
  loggerProvider,
  sessionSyncCallback: syncSession,
});
const firstSession = await firstRuntime.createSession({
  agent: firstAgent,
  context: {
    source: {
      type: "example",
      id: "session-storage:first-workspace",
    },
    attributes: {
      tenantId: "demo-tenant",
      userId: "demo-user",
      workspaceName: "workspace-a",
    },
  },
});

const runtimeSessionId = firstSession.info().runtimeSession.id;

try {
  await runTurn(firstAgent, firstSession, firstTurn);
} finally {
  await firstSession.abort();
}

console.log("");
console.log("Archived session files:");
for (const file of await readdir(getArchivedSessionDir(runtimeSessionId))) {
  console.log(`- ${file}`);
}
console.log("");

const secondAgent = await createExampleAgent(secondWorkspace);
const secondRuntime = createCloudPiRuntimeAdapter({
  loggerProvider,
  sessionRestoreHandler: restoreSession,
  sessionSyncCallback: syncSession,
});
const secondSession = await secondRuntime.createSession({
  agent: secondAgent,
  context: {
    source: {
      type: "example",
      id: "session-storage:restored-workspace",
    },
    attributes: {
      tenantId: "demo-tenant",
      userId: "demo-user",
      workspaceName: "workspace-b",
    },
  },
  runtimeSession: {
    type: "cloud-pi-agent",
    id: runtimeSessionId,
  },
});

try {
  await runTurn(secondAgent, secondSession, secondTurn);
} finally {
  await secondSession.abort();
}

function getArchivedSessionDir(runtimeSessionId: string): string {
  return join(longTermStorage, encodeURIComponent(agentId), encodeURIComponent(runtimeSessionId));
}

async function createExampleAgent(workspace: string): Promise<ExpertAgent> {
  await ensureWorkspaceDir(workspace);

  return ExpertAgent.create({
    id: agentId,
    name: "Session Storage Example Expert",
    description: "Demonstrates runtime session sync and restore across workspace changes.",
    tags: ["example", "session-storage"],
    version: "0.0.0",
    scope: "local-test",
    workspace,
    loggerProvider,
    models: createExpertAgentModelsConfig(modelConfig),
  });
}

async function runTurn(
  agent: ExpertAgent,
  session: RuntimeAgentSession,
  query: string,
): Promise<void> {
  printRunHeader(agent, formatModelConfig(modelConfig), query);
  const run = session.submit({ query });

  await printRunStream(run);

  const result = await run.result;
  printRunResult(result.runId);
  console.log("");
}
