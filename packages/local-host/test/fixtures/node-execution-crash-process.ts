import { appendFile, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { createStaticRuntimeResolver } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { createMissionStore } from "../../src/missions/repository/mission-store.ts";
import { PragmaPaths } from "@pragma/core";
import { PUBLISHED_FLOW_ID } from "./published-project.ts";
import { createLocalHostNodeApplication } from "../../src/node-application.ts";

const [home, missionId, requestId, workspacePath] = process.argv.slice(2);
if (home === undefined || missionId === undefined || requestId === undefined)
  throw new Error("Missing crash fixture arguments.");
const driver = defineRuntimeTestDriver<
  never,
  { readonly id: string; readonly systemSessionId: string }
>({
  descriptor: { id: "codex", kind: "test", displayName: "Fixture" },
  createSession: ({ systemSessionId }) => ({ id: `native-${systemSessionId}`, systemSessionId }),
  restoreSession: ({ systemSessionId }) => ({ id: `native-${systemSessionId}`, systemSessionId }),
  cancelTurn: () => undefined,
  closeSession: () => undefined,
  readSession: (session) => ({ runtimeSessionId: session.id }),
  startTurn: async (session) => {
    await appendFile(
      join(home, "native-dispatches.jsonl"),
      JSON.stringify({
        requestId,
        systemSessionId: session.systemSessionId,
        runtimeSessionId: session.id,
      }) + "\n",
    );
    await writeFile(
      join(home, "crash-ready.json"),
      JSON.stringify({
        requestId,
        systemSessionId: session.systemSessionId,
        runtimeSessionId: session.id,
      }),
    );
    await new Promise<never>(() => undefined);
    throw new Error("Unreachable crash fixture turn.");
  },
  mapEvent: () => ({ events: [] }),
});
const app = createLocalHostNodeApplication({
  pragmaHome: home,
  runtimes: createStaticRuntimeResolver({ defaultRuntimeId: "codex", runtimes: [driver] }),
  client: { surface: "cli", version: "test", instanceId: randomUUID() },
  workspace: {
    stat: async () => ({ isDirectory: () => true }),
    access: async () => undefined,
    realpath: async (path) => path,
  },
});
if (missionId === "flow-fresh") {
  if (workspacePath === undefined) throw new Error("Missing Flow workspace.");
  const started = await app.run!.start({
    requestId,
    command: "flow.run",
    executor: { kind: "flow", id: PUBLISHED_FLOW_ID },
    project: { projectId: "studio", revision: 1 },
    workspace: await app.resolveWorkspace(workspacePath),
    input: {},
    detach: true,
  });
  const mission = await createMissionStore({
    missionsPath: new PragmaPaths({ pragmaHome: home }).missionsRoot(),
  }).get(started.missionId);
  await writeFile(
    join(home, "flow-started.json"),
    JSON.stringify({ missionId: started.missionId, executionId: mission.execution?.id }),
  );
} else {
  await app.missionControl!.submit({
    missionId,
    requestId,
    kind: "send",
    payload: { kind: "send", input: { prompt: "child active turn" } },
  });
  const accepted = await app.missionControl!.waitForTerminal({
    missionId,
    requestId,
    timeoutMs: 10_000,
  });
  if (accepted.state !== "applied") throw new Error(JSON.stringify(accepted));
}
// Keep the real controller/session heartbeat alive until the parent kills it.
setInterval(() => undefined, 1_000);
