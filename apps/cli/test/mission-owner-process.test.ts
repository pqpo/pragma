import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { createMissionControllerStore, createMissionQuery } from "@pragma/local-host";
import { parseCliArgv } from "../src/parser/argv.ts";
import { waitForOwnedOutcome } from "../src/mission-owner-process.ts";

function client(
  home: string,
): Promise<{ code: number | null; result: Record<string, unknown>; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        createRequire(import.meta.url).resolve("tsx"),
        fileURLToPath(new URL("./fixtures/mission-owner-client.ts", import.meta.url)),
      ],
      { env: { ...process.env, PRAGMA_TEST_OWNER_HOME: home } },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        resolve({ code, result: stdout.trim() ? JSON.parse(stdout) : {}, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
}

describe("Mission owner process", () => {
  it("finishes after the client exits and an exact retry never starts a second execution", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-cli-owner-"));
    try {
      const first = await client(home);
      expect(first.stderr).toBe("");
      expect(first.code).toBe(0);
      expect(first.result).toMatchObject({
        status: "accepted",
        result: { waitExpired: true, missionContinues: true },
      });
      const missionId = String(first.result.missionId);
      const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
      const query = createMissionQuery({ controller });
      await vi.waitFor(
        async () => {
          expect(await query.queryMission({ missionId, view: "result", limit: 1 })).toMatchObject({
            status: "succeeded",
            result: { answer: "finished after client exit" },
          });
          expect((await controller.readSnapshot({ missionId })).snapshot.lease).toBeUndefined();
        },
        { timeout: 10000, interval: 50 },
      );
      const retry = await client(home);
      expect(retry.code).toBe(0);
      expect(retry.result).toMatchObject({ status: "succeeded", missionId });
      expect((await readFile(join(home, "starts.jsonl"), "utf8")).trim().split("\n")).toHaveLength(
        1,
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  }, 20000);
  it("keeps finite execution waiting distinct from acknowledgement and TTY interaction", () => {
    const run = [
      "expert",
      "run",
      "expert:aaaaaaaaaaaaaaaa",
      "--workspace",
      "/workspace",
      "--prompt",
      "task",
    ];
    expect(parseCliArgv([...run, "--wait-timeout", "2"]).command).toMatchObject({
      waitTimeoutSeconds: 2,
    });
    expect(() => parseCliArgv([...run, "--wait-timeout", "2", "--detach"])).toThrow();
    expect(() =>
      parseCliArgv([...run, "--wait-timeout", "2", "--interactive", "always"]),
    ).toThrow();
    const id = "11111111-1111-4111-8111-111111111111";
    expect(
      parseCliArgv([
        "mission",
        "send",
        id,
        "--prompt",
        "task",
        "--wait-timeout",
        "2",
        "--ack-timeout",
        "30",
      ]).command,
    ).toMatchObject({ wait: true, waitTimeoutSeconds: 2, ackTimeoutSeconds: 30 });
  });
  it("does not leave a timer behind when an embedded operation finishes first", async () => {
    let resolveReceipt!: (value: { missionId: string }) => void;
    const receipt = new Promise<{ missionId: string }>((resolve) => {
      resolveReceipt = resolve;
    });
    expect(await waitForOwnedOutcome(Promise.resolve("done"), receipt, 20)).toBe("done");
    resolveReceipt({ missionId: "m1" });
    await Promise.resolve();
  });
});
