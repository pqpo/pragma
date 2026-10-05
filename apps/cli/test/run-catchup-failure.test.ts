import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createControllerRunMissionPort,
  createLocalHostRunApplication,
  createLocalHostRunHandleState,
  createMissionControllerStore,
} from "@pragma/local-host";
import { expect, it, vi } from "vitest";
import { runCli, type CliLocalHost } from "../src/index.ts";

it.each(["completed", "waiting"] as const)(
  "fails the CLI onEvent/result path and releases its Mission when Human catch-up fails (Native=%s)",
  async (native) => {
    const home = await mkdtemp(join(tmpdir(), "pragma-cli-catchup-"));
    const controller = createMissionControllerStore({ missionsPath: join(home, "missions") });
    const workspace = {
      schemaVersion: "pragma.integration-workspace/v1" as const,
      requestedPath: home,
      canonicalPath: home,
      displayName: "workspace",
      identityHash: `sha256:${"b".repeat(64)}`,
      access: { exists: true, readable: true, writable: true },
      source: "explicit" as const,
    };
    const sequence: string[] = [];
    const cancel = vi.fn(async () => {
      sequence.push("cancel");
      finishNative("cancelled");
    });
    const release = vi.fn(async () => {
      expect(cancel).toHaveBeenCalled();
      sequence.push("release");
    });
    let finishNative!: (value: unknown) => void;
    const nativeResult =
      native === "completed"
        ? Promise.resolve("done")
        : new Promise((resolve) => {
            finishNative = resolve;
          });
    if (native === "completed") finishNative = () => undefined;
    const executions = {
      readEvents: vi.fn(async () => {
        throw new Error("durable history read failed");
      }),
      get: async () => ({ status: "running" }),
    } as unknown as Parameters<typeof createLocalHostRunHandleState>[0]["executions"];
    let missionId!: string;
    const subscriptionClose = vi.fn(async () => undefined);
    const run = createLocalHostRunApplication({
      mission: createControllerRunMissionPort(controller),
      executors: {
        resolve: async ({ ref }) => ({
          descriptor: {
            schemaVersion: "pragma.integration-executor/v1",
            ref,
            name: "Fixture",
            description: "Fixture",
            source: "project",
            project: { projectId: "aaaaaaaaaaaaaaaa", revision: 1, fingerprint: "a".repeat(64) },
            availability: { status: "ready", blockingCodes: [] },
            workspace: { required: true, allowNonGitDirectory: true },
            capabilities: {
              interactive: true,
              resumable: true,
              steerable: false,
              supportsQueue: false,
            },
          },
        }),
        start: async (input) => {
          missionId = input.missionId;
          expect(input.onEvent).toBeTypeOf("function");
          return createLocalHostRunHandleState({
            missionId,
            executions,
            release,
            onEvent: input.onEvent,
            coreHandle: {
              executionId: randomUUID(),
              result: nativeResult,
              cancel,
              subscribeEvents: async () => ({
                [Symbol.asyncIterator]: async function* () {
                  /* catch-up fails before live consumption */
                },
                close: subscriptionClose,
              }),
            } as Parameters<typeof createLocalHostRunHandleState>[0]["coreHandle"],
          }).handle;
        },
      },
    });
    const io = { writeStdout: vi.fn(), writeStderr: vi.fn() };
    try {
      const exit = await runCli(
        [
          "expert",
          "run",
          "expert:aaaaaaaaaaaaaaaa",
          "--workspace",
          home,
          "--prompt",
          "hello",
          "--project",
          "aaaaaaaaaaaaaaaa",
          "--revision",
          "1",
          "--format=jsonl",
        ],
        io,
        {
          localHost: { run, resolveWorkspace: async () => workspace } as unknown as CliLocalHost,
          terminal: { isControllingTerminal: () => false, readLine: async () => "" },
        },
      );
      expect(exit).not.toBe(0);
      expect(
        sequence,
        io.writeStdout.mock.calls.flat().join("") + io.writeStderr.mock.calls.flat().join(""),
      ).toEqual(["cancel", "release"]);
      expect(subscriptionClose).toHaveBeenCalledOnce();
      expect((await controller.readSnapshot({ missionId })).lease).toBeUndefined();
      expect(io.writeStdout.mock.calls.map(([text]) => text).join("")).not.toContain(
        '"status":"succeeded"',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
  5_000,
);
