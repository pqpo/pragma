import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  createFileExecutionStore,
  createFileExpertSessionStore,
  createPragma,
  createStaticRuntimeResolver,
  defineExpert,
  defineRuntimeDriver,
  type RuntimeDriverSessionContext,
} from "../src/index.ts";
import { createRuntimeTestFeatures } from "../src/testing/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

interface FixtureSession {
  readonly context: RuntimeDriverSessionContext;
  readonly id: string;
}

describe("queue steer crash recovery", () => {
  it("restores the original queued item after an owner dies after durable reservation", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-queue-steer-crash-"));
    roots.push(pragmaHome);
    const sessionId = "queue-steer-crash-session";
    const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
    const tsxLoader = await resolveTsxLoader(repositoryRoot);
    const crashPhase = "release-after-retire";
    const child = spawn(
      process.execPath,
      [
        "--import",
        tsxLoader,
        fileURLToPath(new URL("./fixtures/queue-steer-crash.ts", import.meta.url)),
        "seed",
        pragmaHome,
        sessionId,
        crashPhase,
      ],
      { cwd: repositoryRoot, detached: process.platform !== "win32", stdio: "pipe" },
    );

    try {
      await waitForLine(child, "release-ready");
      child.stdin.end("release\n");
      await waitForExit(child);
      expect(child.signalCode).toBe("SIGKILL");

      const executions = createFileExecutionStore({ pragmaHome });
      const sessions = createFileExpertSessionStore({ executions, pragmaHome });
      const app = createPragma({
        pragmaHome,
        runtimes: createStaticRuntimeResolver({
          runtimes: [createRecoveryRuntime()],
          defaultRuntimeId: "queue-steer-crash-runtime",
        }),
        executionStore: executions,
        expertSessionStore: sessions,
      });
      const expert = await defineExpert({
        id: "queue-steer-crash-expert",
        name: "Queue steer crash expert",
        description: "Exercises durable queue steer recovery.",
        tags: [],
        scope: "test",
        workspace: pragmaHome,
      });

      const recovered = await app.experts.resumeSession(expert, { sessionId });
      await expect(recovered.getPromptQueue()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            requestId: "redirect",
            mode: "enqueue",
            executionId: expect.any(String),
            status: "queued",
          }),
        ]),
      );
      const restored = (await recovered.getPromptQueue()).find(
        (prompt) => prompt.requestId === "redirect",
      );
      expect(restored).not.toHaveProperty("targetExecutionId");
      expect(restored).not.toHaveProperty("error");
      expect((await recovered.getState()).activeExecutionId).toBeUndefined();
      await recovered.close();
    } finally {
      if (child.exitCode === null && child.signalCode === null) killProcessTree(child, "SIGKILL");
    }
  }, 20_000);
});

function createRecoveryRuntime() {
  return defineRuntimeDriver<never, FixtureSession>({
    features: createRuntimeTestFeatures({ enabled: ["cancellation", "close"] }),
    descriptor: {
      id: "queue-steer-crash-runtime",
      kind: "fake",
      displayName: "Queue steer crash runtime",
    },
    createSession: async (context) => ({
      context,
      id: `native-${context.systemSessionId}`,
    }),
    restoreSession: (context) => ({
      context,
      id: context.request.runtimeSession!.id,
    }),
    readSession: (session) => ({ runtimeSessionId: session.id }),
    startTurn: async () => ({ outputText: "recovery", runtimeSessionId: "recovery" }),
    mapEvent: () => ({ events: [] }),
    cancelTurn: () => undefined,
    closeSession: () => undefined,
  });
}

async function waitForLine(child: ChildProcessWithoutNullStreams, expected: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const finish = (callback: () => void) => {
      child.stdout.off("data", onStdout);
      child.stderr.off("data", onStderr);
      child.off("exit", onExit);
      callback();
    };
    const onStdout = (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.split("\n").includes(expected)) finish(resolve);
    };
    const onStderr = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    };
    const onExit = () =>
      finish(() => reject(new Error(`Queue steer crash fixture exited early: ${stderr}`)));
    child.stdout.on("data", onStdout);
    child.stderr.on("data", onStderr);
    child.on("exit", onExit);
  });
}

async function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}

function killProcessTree(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    // The fixture may have exited between the state marker and the kill.
  }
}

async function resolveTsxLoader(repositoryRoot: string): Promise<string> {
  const launcher = await readFile(join(repositoryRoot, "node_modules", ".bin", "tsx"), "utf8");
  const match = launcher.match(/node_modules\/\.pnpm\/([^/]+)\/node_modules\/tsx/u);
  if (match?.[1] === undefined) throw new Error("Could not locate the repository tsx loader.");
  return join(
    repositoryRoot,
    "node_modules",
    ".pnpm",
    match[1],
    "node_modules",
    "tsx",
    "dist",
    "loader.mjs",
  );
}
