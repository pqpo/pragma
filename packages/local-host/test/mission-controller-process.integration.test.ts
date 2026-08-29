import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMissionControllerStore } from "../src/index.ts";
import { createIntegrationError } from "@pragma/shared/integration";
import { SIGKILL_REPLAY_TEST_NAME } from "./mission-controller-process.test-names.ts";

const roots: string[] = [];
const children = new Set<ChildProcess>();
const fixture = join(import.meta.dirname, "fixtures", "mission-controller-process.ts");
const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
const tsxLoader = resolveTsxLoader(repositoryRoot);

afterEach(async () => {
  const activeChildren = [...children].filter(
    (child) => child.exitCode === null && child.signalCode === null,
  );
  activeChildren.forEach((child) => killProcessTree(child, "SIGKILL"));
  await Promise.all(
    activeChildren.map(async (child) => await waitForExit(child, true).catch(() => undefined)),
  );
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("MissionControllerStore cross-process integration", () => {
  it("runs 100 real two-process races with exactly one owner for every Mission", async () => {
    const root = await temporaryRoot();
    const startPath = join(root, "start");
    const firstOutput = join(root, "first.json");
    const secondOutput = join(root, "second.json");
    const first = child(
      root,
      "race",
      `00000000-0000-4000-8000-000000000010|${startPath}|${firstOutput}`,
    );
    const second = child(
      root,
      "race",
      `00000000-0000-4000-8000-000000000011|${startPath}|${secondOutput}`,
    );

    await Promise.all([waitForLine(first), waitForLine(second)]);
    await writeFile(startPath, "go");
    await Promise.all([waitForExit(first), waitForExit(second)]);

    const outcomes = [
      ...(JSON.parse(await readFile(firstOutput, "utf8")) as ProcessOutcome[]),
      ...(JSON.parse(await readFile(secondOutput, "utf8")) as ProcessOutcome[]),
    ];
    for (let index = 1; index <= 100; index += 1) {
      const missionId = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const contenders = outcomes.filter((outcome) => outcome.missionId === missionId);
      expect(contenders).toHaveLength(2);
      expect(contenders.filter((outcome) => outcome.code === undefined)).toHaveLength(1);
      expect(contenders.filter((outcome) => outcome.code !== undefined)).toEqual([
        expect.objectContaining({ code: "MISSION_LEASE_HELD" }),
      ]);
    }
  }, 30_000);

  it("allows different Missions to claim in parallel without a global aggregate lock", async () => {
    const root = await temporaryRoot();
    const first = child(
      root,
      "claim",
      `${mission(201)}|00000000-0000-4000-8000-000000000021|1000|180`,
    );
    const second = child(
      root,
      "claim",
      `${mission(202)}|00000000-0000-4000-8000-000000000022|1000|180`,
    );
    await Promise.all([waitForLine(first), waitForLine(second)]);
    const startedAt = performance.now();
    await Promise.all([waitForExit(first), waitForExit(second)]);
    expect(performance.now() - startedAt).toBeLessThan(300);
  }, 10_000);

  it("takes over after expiry, fences the old process writer, and recovers after SIGKILL", async () => {
    const root = await temporaryRoot();
    const target = mission(301);
    const original = child(
      root,
      "claim-then-assert",
      `${target}|00000000-0000-4000-8000-000000000031|40|2000`,
    );
    const originalLines = collectLines(original);
    const originalGrant = JSON.parse(await originalLines.next()) as { readonly guard: unknown };
    expect(originalGrant.guard).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 100));
    const takeover = child(root, "claim", `${target}|00000000-0000-4000-8000-000000000032|1000`);
    await expect(waitForLine(takeover)).resolves.toContain("fencingToken");
    await waitForExit(takeover);
    await expect(originalLines.next()).resolves.toContain("MISSION_FENCING_REJECTED");
    await waitForExit(original);

    const killedMission = mission(302);
    const killed = child(
      root,
      "claim",
      `${killedMission}|00000000-0000-4000-8000-000000000033|50|5000`,
    );
    await expect(waitForLine(killed)).resolves.toContain("fencingToken");
    killProcessTree(killed, "SIGKILL");
    await waitForExit(killed, true);
    await new Promise((resolve) => setTimeout(resolve, 70));
    const recovered = child(
      root,
      "claim",
      `${killedMission}|00000000-0000-4000-8000-000000000034|1000`,
    );
    await expect(waitForLine(recovered)).resolves.toContain("fencingToken");
    await waitForExit(recovered);
  }, 15_000);

  it.each(["apply", "reject", "expire"] as const)(
    "applies cross-process Inbox %s exactly once with deduplicated durable events",
    async (mode) => {
      const root = await temporaryRoot();
      const target = mission(mode === "apply" ? 401 : mode === "reject" ? 402 : 403);
      const requestId = `00000000-0000-4000-8000-0000000004${mode === "apply" ? "01" : mode === "reject" ? "02" : "03"}`;
      const owner = createMissionControllerStore({ missionsPath: root });
      const guard = await owner.claim({
        missionId: target,
        claimId: "00000000-0000-4000-8000-000000000404",
        leaseMs: 10_000,
      });
      const producer = child(root, "append-inbox", `${target}|${requestId}|${mode}`);
      await expect(waitForLine(producer)).resolves.toBe("appended");
      await waitForExit(producer);
      if (mode === "apply") {
        const duplicate = child(root, "append-inbox", `${target}|${requestId}|${mode}`);
        await expect(waitForLine(duplicate)).resolves.toBe("appended");
        await waitForExit(duplicate);
      }
      const apply = async () => {
        if (mode === "reject") {
          throw createIntegrationError({
            code: "STEER_TARGET_CHANGED",
            category: "conflict",
            message: "Rejected by the owner process.",
          });
        }
        return { result: { mode } };
      };
      await owner.processNext({ missionId: target, guard, consumer: { apply } });
      const operation = await owner.getOperation({ missionId: target, requestId });
      expect(operation).toMatchObject({
        state: mode === "apply" ? "applied" : mode === "reject" ? "rejected" : "expired",
      });
      const snapshot = await owner.readSnapshot({ missionId: target });
      const eventIds = snapshot.events.map((event) => event.eventId);
      expect(new Set(eventIds).size).toBe(eventIds.length);
      expect(snapshot.events.filter((event) => event.type === "command.accepted")).toHaveLength(
        mode === "expire" ? 0 : 1,
      );
      expect(snapshot.events).toHaveLength(mode === "expire" ? 1 : 2);
    },
    20_000,
  );

  it("follows a live Mission from another process without claiming or interrupting its owner", async () => {
    const root = await temporaryRoot();
    const target = mission(405);
    const outputPath = join(root, "watch.json");
    const store = createMissionControllerStore({ missionsPath: root });
    const guard = await store.claim({
      missionId: target,
      claimId: "00000000-0000-4000-8000-000000000409",
      leaseMs: 10_000,
    });
    await store.write({
      missionId: target,
      guard,
      operation: async ({ appendEvent }) => {
        await appendEvent(
          "mission.created",
          { requestId: "00000000-0000-4000-8000-000000000410" },
          "00000000-0000-4000-8000-000000000411",
        );
        await appendEvent(
          "run.started",
          { executionId: "00000000-0000-4000-8000-000000000412" },
          "00000000-0000-4000-8000-000000000413",
        );
      },
    });
    const before = (await store.readSnapshot({ missionId: target })).snapshot.lease;
    const watcher = child(root, "watch", `${target}|${outputPath}`);
    const lines = collectLines(watcher);
    await expect(lines.next()).resolves.toBe("event:mission.snapshot");

    await store.write({
      missionId: target,
      guard,
      operation: async ({ appendEvent }) =>
        await appendEvent(
          "run.succeeded",
          { executionId: "00000000-0000-4000-8000-000000000412", result: { ok: true } },
          "00000000-0000-4000-8000-000000000414",
        ),
    });
    await expect(lines.next()).resolves.toBe("event:watch.ready");
    await expect(lines.next()).resolves.toBe("event:run.succeeded");
    await expect(lines.next()).resolves.toBe("done");
    await waitForExit(watcher);

    const result = JSON.parse(await readFile(outputPath, "utf8")) as {
      readonly result: { readonly status: string; readonly lastCursor: string };
      readonly events: readonly { readonly type: string; readonly eventId?: string }[];
    };
    expect(result.result.status).toBe("completed");
    expect(result.events.map((event) => event.type)).toEqual([
      "mission.snapshot",
      "watch.ready",
      "run.succeeded",
    ]);
    expect(result.events[2]?.eventId).toBe("00000000-0000-4000-8000-000000000414");
    expect((await store.readSnapshot({ missionId: target })).snapshot.lease).toEqual(before);
  }, 20_000);
});

interface ProcessOutcome {
  readonly missionId: string;
  readonly owner: string;
  readonly code?: string;
}

function child(missionsPath: string, action: string, value: string): ChildProcess {
  const childProcess = spawn(
    process.execPath,
    ["--import", tsxLoader, fixture, missionsPath, action, value],
    {
      cwd: repositoryRoot,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    },
  );
  children.add(childProcess);
  childProcess.once("close", () => children.delete(childProcess));
  return childProcess;
}

it(
  SIGKILL_REPLAY_TEST_NAME,
  async () => {
    const root = await temporaryRoot();
    const target = mission(404);
    const requestId = "00000000-0000-4000-8000-000000000406";
    const deliveriesPath = join(root, "deliveries.log");
    const sideEffectPath = join(root, "side-effect.txt");
    const store = createMissionControllerStore({ missionsPath: root });
    const appended = await store.appendCommand({
      missionId: target,
      kind: "send",
      request: {
        schemaVersion: "pragma.integration-request/v1",
        requestId,
        payloadHash: `sha256:${"b".repeat(64)}`,
        requestedAt: "2026-08-24T00:00:00.000Z",
        client: {
          surface: "cli",
          version: "process-test",
          instanceId: "00000000-0000-4000-8000-000000000099",
        },
      },
      payload: { kind: "send", input: { prompt: "kill after side effect" } },
    });
    const interrupted = child(
      root,
      "apply-then-hang",
      `${target}|00000000-0000-4000-8000-000000000407|50|${deliveriesPath}|${sideEffectPath}`,
    );
    await expect(waitForLine(interrupted)).resolves.toBe("side-effect");
    killProcessTree(interrupted, "SIGKILL");
    await waitForExit(interrupted, true);

    await new Promise((resolve) => setTimeout(resolve, 70));
    const recovered = child(
      root,
      "apply-once",
      `${target}|00000000-0000-4000-8000-000000000408|1000|${deliveriesPath}|${sideEffectPath}`,
    );
    await expect(waitForLine(recovered)).resolves.toBe("side-effect");
    await expect(waitForLine(recovered)).resolves.toBe("applied");
    await waitForExit(recovered);

    expect((await readFile(deliveriesPath, "utf8")).trim().split("\n")).toEqual([
      appended.command.commandId,
      appended.command.commandId,
    ]);
    await expect(readFile(sideEffectPath, "utf8")).resolves.toBe(appended.command.commandId);
    await expect(store.getOperation({ missionId: target, requestId })).resolves.toMatchObject({
      state: "applied",
    });
    const snapshot = await store.readSnapshot({ missionId: target });
    expect(snapshot.events.filter((event) => event.type === "command.accepted")).toHaveLength(1);
    expect(snapshot.events.filter((event) => event.type === "command.applied")).toHaveLength(1);
    expect(new Set(snapshot.events.map((event) => event.eventId)).size).toBe(
      snapshot.events.length,
    );
    expect(snapshot.events.map((event) => event.sequence)).toEqual([1, 2]);
  },
  15_000,
);

async function waitForLine(process: ChildProcess): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = "";
    const stderr: string[] = [];
    let settled = false;
    const onStdout = (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.indexOf("\n");
      if (line >= 0) finish(() => resolve(output.slice(0, line)));
    };
    const onStderr = (chunk: Buffer) => stderr.push(chunk.toString());
    const onError = (error: Error) => finish(() => reject(error));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (!output.includes("\n"))
        finish(() =>
          reject(new Error(`Child exited before output: ${code ?? signal}; ${stderr.join("")}`)),
        );
    };
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      process.stdout?.off("data", onStdout);
      process.stderr?.off("data", onStderr);
      process.off("error", onError);
      process.off("close", onClose);
      done();
    };
    process.stdout?.on("data", onStdout);
    process.stderr?.on("data", onStderr);
    process.once("error", onError);
    process.once("close", onClose);
    if (process.exitCode !== null || process.signalCode !== null)
      onClose(process.exitCode, process.signalCode);
  });
}

function collectLines(process: ChildProcess): { next(): Promise<string> } {
  const lines: string[] = [];
  const waiters: Array<{
    readonly resolve: (line: string) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  let buffered = "";
  let closed = process.exitCode !== null || process.signalCode !== null;
  let closeError: Error | undefined;
  const onStdout = (chunk: Buffer) => {
    buffered += chunk.toString();
    while (true) {
      const end = buffered.indexOf("\n");
      if (end < 0) break;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) lines.push(line);
      else waiter.resolve(line);
    }
  };
  const onError = (error: Error) => {
    closed = true;
    closeError = error;
    rejectWaiters(error);
  };
  const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
    closed = true;
    closeError = new Error(`Child exited before output: ${code ?? signal}`);
    rejectWaiters(closeError);
    process.stdout?.off("data", onStdout);
    process.off("error", onError);
    process.off("close", onClose);
  };
  process.stdout?.on("data", onStdout);
  process.once("error", onError);
  process.once("close", onClose);
  if (closed) onClose(process.exitCode, process.signalCode);
  return {
    next: async () =>
      await new Promise<string>((resolve, reject) => {
        const line = lines.shift();
        if (line !== undefined) {
          resolve(line);
          return;
        }
        if (closed) {
          reject(closeError ?? new Error("Child exited before output."));
          return;
        }
        waiters.push({ resolve, reject });
        if (closed) {
          const waiter = waiters.pop();
          waiter?.reject(closeError ?? new Error("Child exited before output."));
        }
      }),
  };

  function rejectWaiters(error: Error): void {
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  }
}

async function waitForExit(process: ChildProcess, allowFailure = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const onError = (error: Error) => finish(() => reject(error));
    const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
      if (allowFailure || (code === 0 && signal === null)) finish(resolve);
      else finish(() => reject(new Error(`Child failed: code=${code}; signal=${signal}`)));
    };
    const finish = (done: () => void): void => {
      if (settled) return;
      settled = true;
      process.off("error", onError);
      process.off("close", onClose);
      done();
    };
    process.once("error", onError);
    process.once("close", onClose);
    if (process.exitCode !== null || process.signalCode !== null)
      onClose(process.exitCode, process.signalCode);
  });
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    } else {
      process.kill(-child.pid, signal);
    }
  } catch {
    // The fixture may have exited between the state check and the kill.
  }
}

function resolveTsxLoader(repositoryRoot: string): string {
  const launcher = readFileSync(join(repositoryRoot, "node_modules", ".bin", "tsx"), "utf8");
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

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-local-host-process-"));
  roots.push(root);
  return root;
}

function mission(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
