import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMissionControllerStore } from "../src/index.ts";
import { createIntegrationError } from "@pragma/shared/integration";

const roots: string[] = [];
const fixture = join(import.meta.dirname, "fixtures", "mission-controller-process.ts");

afterEach(async () => {
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
    killed.kill("SIGKILL");
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
});

interface ProcessOutcome {
  readonly missionId: string;
  readonly owner: string;
  readonly code?: string;
}

function child(missionsPath: string, action: string, value: string): ChildProcess {
  const repositoryRoot = join(import.meta.dirname, "..", "..", "..");
  return spawn(
    join(repositoryRoot, "node_modules", ".bin", "tsx"),
    [fixture, missionsPath, action, value],
    {
      cwd: repositoryRoot,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  it("replays an accepted command after SIGKILL without duplicating its commandId side effect", async () => {
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
    interrupted.kill("SIGKILL");
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
    expect(new Set(snapshot.events.map((event) => event.eventId)).size).toBe(snapshot.events.length);
    expect(snapshot.events.map((event) => event.sequence)).toEqual([1, 2]);
  }, 15_000);
}

async function waitForLine(process: ChildProcess): Promise<string> {
  return await new Promise((resolve, reject) => {
    let output = "";
    const stderr: string[] = [];
    process.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const line = output.indexOf("\n");
      if (line >= 0) resolve(output.slice(0, line));
    });
    process.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    process.once("error", reject);
    process.once("exit", (code) => {
      if (!output.includes("\n"))
        reject(new Error(`Child exited before output: ${code}; ${stderr.join("")}`));
    });
  });
}

function collectLines(process: ChildProcess): { next(): Promise<string> } {
  const lines: string[] = [];
  const waiters: Array<(line: string) => void> = [];
  let buffered = "";
  process.stdout?.on("data", (chunk: Buffer) => {
    buffered += chunk.toString();
    while (true) {
      const end = buffered.indexOf("\n");
      if (end < 0) return;
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      const waiter = waiters.shift();
      if (waiter === undefined) lines.push(line);
      else waiter(line);
    }
  });
  return {
    next: async () =>
      await new Promise<string>((resolve, reject) => {
        const line = lines.shift();
        if (line !== undefined) {
          resolve(line);
          return;
        }
        process.once("error", reject);
        process.once("exit", (code) => {
          if (lines.length > 0) resolve(lines.shift()!);
          else reject(new Error(`Child exited before output: ${code}`));
        });
        waiters.push(resolve);
      }),
  };
}

async function waitForExit(process: ChildProcess, allowFailure = false): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.once("error", reject);
    process.once("exit", (code, signal) => {
      if (allowFailure || (code === 0 && signal === null)) resolve();
      else reject(new Error(`Child failed: code=${code}; signal=${signal}`));
    });
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-local-host-process-"));
  roots.push(root);
  return root;
}

function mission(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
