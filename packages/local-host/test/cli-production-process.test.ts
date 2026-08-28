import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  PUBLISHED_FLOW_ID,
  PUBLISHED_PROJECT_ID,
  PUBLISHED_TEAM_ID,
  writePublishedProjectFixture,
} from "./fixtures/published-project.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

beforeAll(async () => {
  const result = await invoke("pnpm", ["--filter", "@pqpo/pragma...", "build"], {});
  expect(result.exitCode).toBe(0);
}, 120_000);

describe("CLI production project composition", () => {
  it("resolves published Team and Flow entries with exact revision pins", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-cli-project-"));
    roots.push(home);
    const fixture = await writePublishedProjectFixture(home);
    const environment = { PRAGMA_HOME: home, NODE_NO_WARNINGS: "1" };

    const team = await invoke(
      process.execPath,
      [
        "apps/cli/dist/pragma.js",
        "team",
        "discover",
        "--project",
        PUBLISHED_PROJECT_ID,
        "--format=json",
      ],
      environment,
    );
    expect(team.exitCode).toBe(0);
    expect(team.stderr).toBe("");
    expect(JSON.parse(team.stdout)).toMatchObject({
      schemaVersion: "pragma.cli-result/v2",
      status: "succeeded",
      result: {
        items: expect.arrayContaining([
          expect.objectContaining({
            ref: { kind: "team", id: PUBLISHED_TEAM_ID },
            project: expect.objectContaining({
              projectId: PUBLISHED_PROJECT_ID,
              revision: 1,
              fingerprint: fixture.fingerprint,
            }),
          }),
        ]),
      },
    });

    const flow = await invoke(
      process.execPath,
      [
        "apps/cli/dist/pragma.js",
        "flow",
        "describe",
        `flow:${PUBLISHED_FLOW_ID}`,
        "--revision",
        "1",
        "--format=json",
      ],
      environment,
    );
    expect(flow.exitCode).toBe(0);
    expect(flow.stderr).toBe("");
    expect(JSON.parse(flow.stdout)).toMatchObject({
      schemaVersion: "pragma.cli-result/v2",
      status: "succeeded",
      result: {
        ref: { kind: "flow", id: PUBLISHED_FLOW_ID },
        project: expect.objectContaining({
          projectId: PUBLISHED_PROJECT_ID,
          revision: 1,
          fingerprint: fixture.fingerprint,
        }),
      },
    });
  }, 120_000);

  it.runIf(process.env["PRAGMA_RUN_REAL_M7"] === "1")(
    "runs published Team and Flow through the ordinary Node bin and releases resources",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "pragma-cli-real-run-"));
      roots.push(home);
      const fixture = await writePublishedProjectFixture(home);
      const environment = { PRAGMA_HOME: home, NODE_NO_WARNINGS: "1" };
      const initialCodexAppServers = await listCodexAppServers();

      const team = await invoke(
        process.execPath,
        [
          "apps/cli/dist/pragma.js",
          "team",
          "run",
          `team:${PUBLISHED_TEAM_ID}`,
          "--workspace",
          home,
          "--project",
          PUBLISHED_PROJECT_ID,
          "--revision",
          "1",
          "--expected-fingerprint",
          fixture.fingerprint,
          "--prompt",
          "Reply with a short status.",
          "--interactive=never",
          "--format=json",
        ],
        environment,
      );
      expect(team.exitCode).toBe(0);
      const teamDocument = parseJsonResult(team.stdout);
      expect(teamDocument).toMatchObject({ status: "succeeded" });
      await assertDurableExpertRun(home, teamDocument);
      expect(await listCodexAppServers()).toEqual(initialCodexAppServers);

      const flowInput = join(home, "flow-input.json");
      await writeFile(flowInput, "{}\n");
      const flow = await invoke(
        process.execPath,
        [
          "apps/cli/dist/pragma.js",
          "flow",
          "run",
          `flow:${PUBLISHED_FLOW_ID}`,
          "--workspace",
          home,
          "--project",
          PUBLISHED_PROJECT_ID,
          "--revision",
          "1",
          "--expected-fingerprint",
          fixture.fingerprint,
          "--input-json",
          flowInput,
          "--format=json",
        ],
        environment,
      );
      expect(flow.exitCode).toBe(0);
      const flowDocument = parseJsonResult(flow.stdout);
      expect(flowDocument).toMatchObject({ status: "succeeded" });
      await assertDurableFlowRun(home, flowDocument);
      expect(await listCodexAppServers()).toEqual(initialCodexAppServers);
    },
    600_000,
  );
});

type UnknownRecord = Record<string, unknown>;

function parseJsonResult(stdout: string): UnknownRecord {
  const document = JSON.parse(stdout) as UnknownRecord;
  expect(document.schemaVersion).toBe("pragma.cli-result/v2");
  return document;
}

async function assertDurableExpertRun(home: string, document: UnknownRecord): Promise<void> {
  const missionId = stringValue(document, "missionId");
  const executionId = stringValue(document, "executionId");
  const session = record(JSON.parse(await readFile(expertSessionState(home, missionId), "utf8")));
  expect(session["status"]).toBe("open");
  const rootContext = record(record(session["contexts"])[stringValue(session, "rootContextId")]);
  const snapshot = record(rootContext["snapshot"]);
  const runtimeSessionRef = record(snapshot["runtimeSession"]);
  expect(runtimeSessionRef["id"]).toBeTruthy();
  const runtimeSession = record(
    JSON.parse(
      await readFile(
        ownedSystemSessionManifest(home, missionId, stringValue(snapshot, "systemSessionId")),
        "utf8",
      ),
    ),
  );
  expect(runtimeSession["runtimeSessionRef"]).toBeTruthy();
  expect(runtimeSession["processState"]).toBe("stopped");
  expect(JSON.parse(await readFile(executionState(home, executionId), "utf8"))).toMatchObject({
    status: "succeeded",
  });
  await expect(access(expertSessionLease(home, missionId))).rejects.toMatchObject({
    code: "ENOENT",
  });
}

async function assertDurableFlowRun(home: string, document: UnknownRecord): Promise<void> {
  const missionId = stringValue(document, "missionId");
  const executionId = stringValue(document, "executionId");
  expect(JSON.parse(await readFile(executionState(home, executionId), "utf8"))).toMatchObject({
    status: "succeeded",
  });
  await expect(
    readFile(join(home, "data", "missions", missionId, "local-host", "events.jsonl"), "utf8"),
  ).resolves.toContain("run.succeeded");
}

async function listCodexAppServers(): Promise<readonly string[]> {
  const result = await invoke("ps", ["-axo", "command="], {}, undefined);
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.includes("codex") && line.includes("app-server"));
}

function record(value: unknown): UnknownRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Expected a JSON object.");
  }
  return value as UnknownRecord;
}

function stringValue(value: UnknownRecord, key: string): string {
  const result = value[key];
  if (typeof result !== "string") throw new Error(`Expected ${key} to be a string.`);
  return result;
}

function encodedPathSegment(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function expertSessionState(home: string, sessionId: string): string {
  return join(home, "state", "expert-sessions", encodedPathSegment(sessionId), "session.json");
}

function expertSessionLease(home: string, sessionId: string): string {
  return join(home, "state", "expert-sessions", encodedPathSegment(sessionId), "lease.json");
}

function executionState(home: string, executionId: string): string {
  return join(home, "state", "executions", encodedPathSegment(executionId), "execution.json");
}

function ownedSystemSessionManifest(
  home: string,
  ownerId: string,
  systemSessionId: string,
): string {
  return join(
    home,
    "state",
    "runtime-sessions",
    encodedPathSegment(ownerId),
    encodedPathSegment(systemSessionId),
    "session.json",
  );
}

function workspaceRoot(): string {
  return new URL("../../..", import.meta.url).pathname;
}

function invoke(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  input?: string,
): Promise<{ readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: workspaceRoot(),
      env: { ...process.env, ...environment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("error", reject);
    if (input !== undefined) child.stdin.end(input);
    child.once("close", (exitCode) => resolve({ exitCode, stdout, stderr }));
  });
}
