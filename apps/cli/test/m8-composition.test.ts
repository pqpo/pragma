import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  createMissionControllerStore,
  createLocalHostMissionBoardBindings,
  type MissionControlApplication,
} from "@pragma/local-host";
import { CliEventV2StreamSchema, CliResultV2Schema } from "@pragma/local-host/wire";

import { createProductionLocalHost } from "../src/composition/default.ts";
import { runCli, type CliIo, type CliLocalHost } from "../src/index.ts";

const MISSION_ID = "11111111-1111-4111-8111-111111111111";
const CLAIM_ID = "22222222-2222-4222-8222-222222222222";
const EXECUTION_ID = "33333333-3333-4333-8333-333333333333";
const OPERATION_ID = "44444444-4444-4444-8444-444444444444";
const COMMAND_ID = "55555555-5555-4555-8555-555555555555";
const REQUEST_ID = "66666666-6666-4666-8666-666666666666";
const PAYLOAD_HASH = `sha256:${"a".repeat(64)}`;
const TIMESTAMP = "2026-08-27T00:00:00.000Z";

describe("M8 production composition", () => {
  it("composes every Mission watch/resume/mutation/queue port and lists real Mission events", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-cli-composition-"));
    const previousHome = process.env["PRAGMA_HOME"];
    process.env["PRAGMA_HOME"] = pragmaHome;
    try {
      const host = createProductionLocalHost();
      const capability = await host.integrationCapability();

      expect(capability.features).toEqual(
        expect.arrayContaining([
          "mission.watch",
          "mission.resume",
          "mission.send",
          "mission.steer",
          "mission.respond",
          "mission.interrupt",
          "mission.queue.list",
          "mission.queue.remove",
          "mission.queue.resume",
          "mission.queue.steer",
        ]),
      );
      expect(host.watchMission).toEqual(expect.any(Function));
      expect(host.resumeMission).toEqual(expect.any(Function));
      expect(host.missionControl).toEqual(
        expect.objectContaining({
          submit: expect.any(Function),
          wait: expect.any(Function),
        }),
      );
      expect(host.listMissionQueue).toEqual(expect.any(Function));

      const controller = createMissionControllerStore({
        missionsPath: join(pragmaHome, "data", "missions"),
      });
      const guard = await controller.claim({
        missionId: MISSION_ID,
        claimId: CLAIM_ID,
        leaseMs: 10_000,
      });
      await controller.write({
        missionId: MISSION_ID,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.created", {
            executor: { kind: "expert", id: "expert-1" },
            workspace: "/tmp/m8-composition-workspace",
          });
        },
      });
      await controller.release({ missionId: MISSION_ID, guard });

      await expect(host.listMissions()).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: MISSION_ID,
            missionId: MISSION_ID,
            status: "queued",
            lifecycleStatus: "queued",
            executor: { kind: "expert", id: "expert-1" },
          }),
        ]),
      );

      const io = createIo();
      await expect(
        runCli(["mission", "list", "--executor", "expert:expert-1", "--format=json"], io, {
          localHost: host,
        }),
      ).resolves.toBe(0);
      expect(CliResultV2Schema.parse(JSON.parse(io.stdout[0]!))).toMatchObject({
        result: { items: [{ id: MISSION_ID }] },
      });
    } finally {
      if (previousHome === undefined) delete process.env["PRAGMA_HOME"];
      else process.env["PRAGMA_HOME"] = previousHome;
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });

  it("lists only Local Host Missions when Board and Desktop directories share the root", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-cli-mission-list-composition-"));
    const previousHome = process.env["PRAGMA_HOME"];
    const missionId = "370f4e66-c547-4db3-8a46-1af9f1fd4147";
    const legacyMissionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const missionsPath = join(pragmaHome, "data", "missions");
    process.env["PRAGMA_HOME"] = pragmaHome;
    try {
      const controller = createMissionControllerStore({ missionsPath });
      const guard = await controller.claim({
        missionId,
        claimId: CLAIM_ID,
        leaseMs: 10_000,
      });
      await controller.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.created", {
            executor: { kind: "expert", id: "expert-1" },
            workspace: "/tmp/mission-list-workspace",
          });
          await appendEvent("run.started", {
            executionId: EXECUTION_ID,
          });
          await appendEvent("run.succeeded", {
            executionId: EXECUTION_ID,
            result: { ok: true },
          });
        },
      });
      await controller.release({ missionId, guard });

      const bindings = await createLocalHostMissionBoardBindings({ pragmaHome, missionId });
      const shared = bindings.find((binding) => binding.namespace === "mission-board");
      expect(shared).toBeDefined();
      if (shared === undefined) throw new Error("Shared Mission Board binding is missing.");
      await shared.store.addContext({
        id: "plan.md",
        content: "Board data must not become a Mission.",
        metadata: { description: "Plan", trigger: "manual", priority: "high" },
      });

      await mkdir(join(missionsPath, legacyMissionId), { recursive: true });
      await writeFile(
        join(missionsPath, legacyMissionId, "mission.yaml"),
        "legacy: true\n",
        "utf8",
      );
      await mkdir(join(missionsPath, ".desktop-legacy"), { recursive: true });
      await mkdir(join(missionsPath, ".locks"), { recursive: true });

      const host = createProductionLocalHost();
      const snapshots = await host.listMissions();
      expect(snapshots).toHaveLength(1);
      expect(snapshots[0]).toMatchObject({
        id: missionId,
        missionId,
        status: "succeeded",
        lifecycleStatus: "completed",
      });

      const io = createIo();
      await expect(runCli(["mission", "list", "--json"], io, { localHost: host })).resolves.toBe(0);
      expect(io.stderr).toEqual([]);
      const result = CliResultV2Schema.parse(JSON.parse(io.stdout[0]!));
      expect(result).toMatchObject({
        status: "succeeded",
        result: { items: [{ id: missionId }] },
      });
      const items = (result.result as { readonly items: readonly { readonly id: string }[] }).items;
      expect(items).toHaveLength(1);
      expect(items.map((item) => item.id)).toEqual([missionId]);
      expect(JSON.stringify(result)).not.toContain(
        Buffer.from(missionId, "utf8").toString("base64url"),
      );
    } finally {
      if (previousHome === undefined) delete process.env["PRAGMA_HOME"];
      else process.env["PRAGMA_HOME"] = previousHome;
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });

  it("fails closed for a damaged Local Host aggregate after filtering foreign directories", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-cli-mission-list-corrupt-"));
    const previousHome = process.env["PRAGMA_HOME"];
    const missionId = "99999999-9999-4999-8999-999999999999";
    const missionsPath = join(pragmaHome, "data", "missions");
    process.env["PRAGMA_HOME"] = pragmaHome;
    try {
      const controller = createMissionControllerStore({ missionsPath });
      const guard = await controller.claim({
        missionId,
        claimId: CLAIM_ID,
        leaseMs: 10_000,
      });
      await controller.write({
        missionId,
        guard,
        operation: async ({ appendEvent }) =>
          await appendEvent("mission.created", {
            executor: { kind: "expert", id: "expert-1" },
            workspace: "/tmp/mission-list-corrupt-workspace",
          }),
      });
      await controller.release({ missionId, guard });
      await writeFile(join(missionsPath, missionId, "local-host", "aggregate.json"), "{\n", "utf8");

      const host = createProductionLocalHost();
      await expect(host.listMissions()).rejects.toMatchObject({
        code: "STORAGE_CORRUPTED",
        details: { missionId },
      });
      const io = createIo();
      await expect(runCli(["mission", "list", "--json"], io, { localHost: host })).resolves.toBe(7);
      expect(JSON.parse(io.stdout[0]!).error.code).toBe("STORAGE_CORRUPTED");
    } finally {
      if (previousHome === undefined) delete process.env["PRAGMA_HOME"];
      else process.env["PRAGMA_HOME"] = previousHome;
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });

  it("submits a real respond mutation with one UUID client instance per Host", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-cli-mutation-composition-"));
    const previousHome = process.env["PRAGMA_HOME"];
    process.env["PRAGMA_HOME"] = pragmaHome;
    try {
      const controller = createMissionControllerStore({
        missionsPath: join(pragmaHome, "data", "missions"),
      });
      const guard = await controller.claim({
        missionId: MISSION_ID,
        claimId: CLAIM_ID,
        leaseMs: 10_000,
      });
      await controller.write({
        missionId: MISSION_ID,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.created", {
            executor: { kind: "expert", id: "expert-1" },
            workspace: "/tmp/m8-mutation-composition-workspace",
          });
        },
      });

      const host = createProductionLocalHost();
      const submit = async (requestId: string) => {
        const io = createIo();
        await expect(
          runCli(
            [
              "mission",
              "respond",
              MISSION_ID,
              "--interaction",
              "interaction-1",
              "--answer",
              "yes",
              "--request-id",
              requestId,
              "--detach",
              "--format=json",
            ],
            io,
            { localHost: host },
          ),
        ).resolves.toBe(0);
        expect(io.stderr).toEqual([]);
        expect(JSON.parse(io.stdout[0]!)).toMatchObject({
          command: "mission.respond",
          status: "accepted",
        });
      };

      const firstRequestId = "77777777-7777-4777-8777-777777777777";
      const secondRequestId = "88888888-8888-4888-8888-888888888888";
      await submit(firstRequestId);
      await submit(secondRequestId);

      const firstCommand = await controller.getCommand({
        missionId: MISSION_ID,
        requestId: firstRequestId,
      });
      const secondCommand = await controller.getCommand({
        missionId: MISSION_ID,
        requestId: secondRequestId,
      });
      expect(firstCommand).toMatchObject({
        kind: "respond",
        request: {
          requestId: firstRequestId,
          client: {
            surface: "cli",
            instanceId: expect.stringMatching(
              /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
            ),
          },
        },
        payload: {
          kind: "respond",
          response: { answers: "yes" },
        },
      });
      expect(secondCommand).toMatchObject({
        kind: "respond",
        request: { requestId: secondRequestId },
      });
      expect(secondCommand?.request.client.instanceId).toBe(
        firstCommand?.request.client.instanceId,
      );
      await expect(
        controller.getOperation({ missionId: MISSION_ID, requestId: firstRequestId }),
      ).resolves.toMatchObject({ state: "queued", kind: "respond" });
      await expect(
        controller.getOperation({ missionId: MISSION_ID, requestId: secondRequestId }),
      ).resolves.toMatchObject({ state: "queued", kind: "respond" });
      await controller.release({ missionId: MISSION_ID, guard });
    } finally {
      if (previousHome === undefined) delete process.env["PRAGMA_HOME"];
      else process.env["PRAGMA_HOME"] = previousHome;
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });

  it("keeps mission list lifecycle filters and help/completion aligned with the M8 command surface", async () => {
    const host: CliLocalHost = {
      listMissions: async () => [
        {
          id: MISSION_ID,
          status: "running",
          lifecycleStatus: "active",
        },
      ],
    } as unknown as CliLocalHost;
    const listIo = createIo();

    await expect(
      runCli(["mission", "list", "--status=active", "--format=json"], listIo, {
        localHost: host,
      }),
    ).resolves.toBe(0);
    const listResult = CliResultV2Schema.parse(JSON.parse(listIo.stdout[0]!));
    expect(listResult).toMatchObject({
      status: "succeeded",
      result: { items: [{ id: MISSION_ID }] },
    });

    const helpIo = createIo();
    await expect(runCli(["help", "--format=json"], helpIo, { localHost: host })).resolves.toBe(0);
    const help = CliResultV2Schema.parse(JSON.parse(helpIo.stdout[0]!));
    expect(help).toMatchObject({ status: "succeeded" });
    expect(JSON.stringify(help)).toContain("queue steer");
    expect(JSON.stringify(help)).toContain("CURSOR");

    for (const shell of ["bash", "zsh", "fish", "powershell"] as const) {
      const completionIo = createIo();
      await expect(
        runCli(["completion", shell, "--format=json"], completionIo, { localHost: host }),
      ).resolves.toBe(0);
      const completion = CliResultV2Schema.parse(JSON.parse(completionIo.stdout[0]!));
      const script = completion.result;
      expect(script).toEqual(expect.objectContaining({ shell }));
      expect(JSON.stringify(script)).toContain("queue");
      expect(JSON.stringify(script)).toContain("steer");
      expect(JSON.stringify(script)).toContain("--ack-timeout");
    }
  });

  it("connects production Board list/read/search to the shared Mission Board scope", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-cli-board-composition-"));
    const previousHome = process.env["PRAGMA_HOME"];
    process.env["PRAGMA_HOME"] = pragmaHome;
    try {
      const controller = createMissionControllerStore({
        missionsPath: join(pragmaHome, "data", "missions"),
      });
      const guard = await controller.claim({
        missionId: MISSION_ID,
        claimId: CLAIM_ID,
        leaseMs: 10_000,
      });
      await controller.write({
        missionId: MISSION_ID,
        guard,
        operation: async ({ appendEvent }) => {
          await appendEvent("mission.created", {
            executor: { kind: "expert", id: "expert-1" },
            workspace: "/tmp/m8-board-workspace",
          });
        },
      });
      await controller.release({ missionId: MISSION_ID, guard });

      const bindings = await createLocalHostMissionBoardBindings({
        pragmaHome,
        missionId: MISSION_ID,
      });
      const shared = bindings.find((binding) => binding.namespace === "mission-board");
      expect(shared).toBeDefined();
      if (shared === undefined) throw new Error("Shared Mission Board binding is missing.");
      await expect(
        shared.store.addContext({
          id: "plan.md",
          content: "Alpha\nneedle one\nNeedle two\n",
          metadata: { description: "Plan", trigger: "manual", priority: "high" },
        }),
      ).resolves.toMatchObject({ ok: true });

      const host = createProductionLocalHost();
      const capability = await host.integrationCapability();
      expect(capability.features).toContain("board.shared.read");

      const list = await host.listSharedBoard(MISSION_ID);
      expect(list).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "plan.md", namespace: "mission-board" }),
        ]),
      );
      const read = await host.readSharedBoard(MISSION_ID, "plan.md", 6, 6);
      expect(read).toMatchObject({
        id: "plan.md",
        namespace: "mission-board",
        content: "needle",
        contentRange: { startOffset: 6, endOffset: 12, nextStartOffset: 12 },
      });
      const search = await host.searchSharedBoard(MISSION_ID, "Needle", 10, {
        caseSensitive: true,
        contextLines: 1,
      });
      expect(search).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "plan.md",
            lineNumber: expect.any(Number),
            line: "Needle two",
            item: expect.objectContaining({
              namespace: "mission-board",
              revision: expect.any(String),
              sizeBytes: expect.any(Number),
            }),
          }),
        ]),
      );

      const commandCases = [
        ["mission", "board", "list", MISSION_ID],
        ["mission", "board", "read", MISSION_ID, "plan.md", "--start", "6", "--offset", "6"],
        ["mission", "board", "search", MISSION_ID, "Needle", "--case-sensitive"],
      ] as const;
      for (const commandArgs of commandCases) {
        for (const format of ["text", "json", "jsonl"] as const) {
          const io = createIo();
          const args =
            format === "jsonl"
              ? [...commandArgs, "--stream-json"]
              : [...commandArgs, `--format=${format}`];
          await expect(runCli(args, io, { localHost: host })).resolves.toBe(0);
          if (format === "jsonl") {
            const events = CliEventV2StreamSchema.parse(
              io.stdout.map((value) => JSON.parse(value) as unknown),
            );
            expect(events.filter((event) => event.type === "stream.end")).toHaveLength(1);
          } else if (format === "json") {
            expect(CliResultV2Schema.parse(JSON.parse(io.stdout[0]!))).toMatchObject({
              status: "succeeded",
            });
          } else {
            expect(io.stdout.join(""), commandArgs.join(" ")).not.toBe("");
          }
        }
      }

      const privateIo = createIo();
      await expect(
        runCli(
          ["mission", "board", "read", MISSION_ID, "private/secret.md", "--format=json"],
          privateIo,
          {
            localHost: host,
          },
        ),
      ).resolves.toBe(3);
      expect(JSON.parse(privateIo.stdout[0]!).error.code).toBe("BOARD_ITEM_NOT_FOUND");

      const missingIo = createIo();
      await expect(
        runCli(
          ["mission", "board", "list", "55555555-5555-4555-8555-555555555555", "--format=json"],
          missingIo,
          { localHost: host },
        ),
      ).resolves.toBe(3);
      expect(JSON.parse(missingIo.stdout[0]!).error.code).toBe("MISSION_NOT_FOUND");

      const sharedRoot = join(
        pragmaHome,
        "data",
        "missions",
        Buffer.from(MISSION_ID, "utf8").toString("base64url"),
        "board",
        "shared",
      );
      await mkdir(sharedRoot, { recursive: true });
      await writeFile(join(sharedRoot, "broken.md"), "---\ninvalid: [\n", "utf8");
      await expect(host.listSharedBoard(MISSION_ID)).rejects.toMatchObject({
        code: "STORAGE_CORRUPTED",
      });
    } finally {
      if (previousHome === undefined) delete process.env["PRAGMA_HOME"];
      else process.env["PRAGMA_HOME"] = previousHome;
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });

  it.each(["text", "json", "jsonl"] as const)(
    "uses the v2 output contract for mutation results in %s format",
    async (format) => {
      const operation = {
        schemaVersion: "pragma.local-host-mission-operation/v1" as const,
        operationId: OPERATION_ID,
        requestId: REQUEST_ID,
        payloadHash: PAYLOAD_HASH,
        commandId: COMMAND_ID,
        kind: "interrupt",
        state: "applied" as const,
        createdAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        result: { missionId: MISSION_ID, executionId: EXECUTION_ID },
      };
      const submit = vi.fn(async (input: { readonly requestId: string }) => ({
        command: {} as never,
        operation: { ...operation, requestId: input.requestId },
        owner: "live" as const,
      }));
      const wait = vi.fn(async (input: { readonly requestId: string }) => ({
        ...operation,
        requestId: input.requestId,
      }));
      const missionControl = { submit, wait } as unknown as MissionControlApplication;
      const io = createIo();

      await expect(
        runCli(["mission", "interrupt", MISSION_ID, `--format=${format}`], io, {
          localHost: { missionControl } as unknown as CliLocalHost,
        }),
      ).resolves.toBe(0);
      expect(io.stderr).toEqual([]);

      if (format === "text") {
        expect(io.stdout.join(""))
          .toContain("Applied: interrupt")
          .and.toContain(`Mission ID: ${MISSION_ID}`)
          .and.toContain(`Operation ID: ${OPERATION_ID}`)
          .and.toContain("Status: applied");
        return;
      }
      if (format === "json") {
        expect(io.stdout).toHaveLength(1);
        expect(CliResultV2Schema.parse(JSON.parse(io.stdout[0]!))).toMatchObject({
          schemaVersion: "pragma.cli-result/v2",
          command: "mission.interrupt",
          status: "succeeded",
        });
        return;
      }

      const events = CliEventV2StreamSchema.parse(
        io.stdout.map((value) => JSON.parse(value) as unknown),
      );
      expect(events.map((event) => event.type)).toEqual(["command.result", "stream.end"]);
      expect(events.filter((event) => event.type === "stream.end")).toHaveLength(1);
    },
  );

  it("does not leak a Runtime error canary to either output channel", async () => {
    const canary = "m8-secret-canary-value";
    const io = createIo();
    const host = {
      missionControl: {
        submit: async () => {
          throw new Error(canary);
        },
        wait: vi.fn(),
      } as unknown as MissionControlApplication,
    } as unknown as CliLocalHost;

    await expect(
      runCli(["mission", "interrupt", MISSION_ID, "--format=json"], io, { localHost: host }),
    ).resolves.toBe(10);
    expect(`${io.stdout.join("")}\n${io.stderr.join("")}`).not.toContain(canary);
  });
});

function createIo(): CliIo & { readonly stdout: string[]; readonly stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
}
