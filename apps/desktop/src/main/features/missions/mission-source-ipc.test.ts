import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { createMissionStore } from "@pragma/local-host";
import { installMissionHandlers } from "./mission-ipc.ts";

const handlers = vi.hoisted(
  () => new Map<string, (_event: unknown, input: unknown) => Promise<unknown>>(),
);
vi.mock("electron", () => ({
  ipcMain: {
    handle: (name: string, handler: (_event: unknown, input: unknown) => Promise<unknown>) =>
      handlers.set(name, handler),
  },
  protocol: { handle: vi.fn() },
  net: {},
  dialog: {},
}));

it("keeps Mission lists and details readable during source backfill failure and retries enrichment", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-mission-source-ipc-"));
  const missions = createMissionStore({ missionsPath: join(root, "missions") });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const base = {
      workspace: { path: root, basename: "workspace" },
      goal: "An existing task",
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert" as const, ref: "expert:t9ne4d8njvvxv2ea", name: "Expert" },
    };
    const manual = await missions.create(base);
    const legacy = await missions.create(base);
    const ref = "automation:m9a8n9nxvvyb4j01";
    const getAutomationMissionSources = vi
      .fn()
      .mockRejectedValueOnce(new Error("MISSION_DELETION_PENDING"))
      .mockRejectedValueOnce(new Error("source storage unavailable"))
      .mockResolvedValue(new Map([[legacy.id, ref]]));
    installMissionHandlers({
      missions,
      localHost: {
        listMissions: () => missions.list(),
        getMission: (id: string) => missions.get(id),
      },
      application: {
        subscribeCommandOutcomes: vi.fn(),
        subscribeChat: vi.fn(),
        subscribeStatus: vi.fn(),
        subscribeWork: vi.fn(),
        subscribeWorkConversationStreams: vi.fn(),
      },
      getAutomationMissionSources,
      getWindow: () => null,
      temporaryRoot: join(root, "tmp"),
    } as unknown as Parameters<typeof installMissionHandlers>[0]);
    const list = handlers.get("missions:list")!;
    const detail = handlers.get("missions:get")!;
    const initial = await list({}, undefined);
    expect(initial).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: manual.id }),
        expect.objectContaining({ id: legacy.id }),
      ]),
    );
    await expect(detail({}, manual.id)).resolves.toMatchObject({
      ok: true,
      value: { id: manual.id },
    });
    expect(warning).toHaveBeenCalledTimes(2);
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining("automation_mission_sources_unavailable"),
    );
    await expect(list({}, undefined)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: legacy.id,
          source: { type: "automation", automationRef: ref },
        }),
        expect.objectContaining({ id: manual.id, source: { type: "task" } }),
      ]),
    );
    await list({}, undefined);
    expect(getAutomationMissionSources).toHaveBeenCalledTimes(3);
    expect((await missions.get(manual.id)).origin).toEqual({ type: "user" });
  } finally {
    warning.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("projects hidden Memory command outcomes without reporting a missing Mission", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-memory-outcome-ipc-"));
  const missions = createMissionStore({ missionsPath: join(root, "missions") });
  const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const subscribeCommandOutcomes = vi.fn();
  const send = vi.fn();
  try {
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Background learning",
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: "expert:0000000000st0rev", name: "Revision" },
      origin: { type: "system-memory", jobId: "knowledge-revision:" + "a".repeat(64) },
    });
    const getMission = vi.fn((id: string) => missions.get(id));
    installMissionHandlers({
      missions,
      localHost: { getMission },
      application: {
        subscribeCommandOutcomes,
        subscribeChat: vi.fn(),
        subscribeStatus: vi.fn(),
        subscribeWork: vi.fn(),
        subscribeWorkConversationStreams: vi.fn(),
      },
      getWindow: () => ({ webContents: { send } }),
      temporaryRoot: join(root, "tmp"),
    } as unknown as Parameters<typeof installMissionHandlers>[0]);
    subscribeCommandOutcomes.mock.calls[0]![0]({
      missionId: mission.id,
      requestId: "request",
      state: "applied",
    });
    await vi.waitFor(() => expect(getMission).toHaveResolved());
    expect(warning).not.toHaveBeenCalled();
    expect(send.mock.calls.map(([channel]) => channel)).not.toContain("missions:updated");
  } finally {
    warning.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

it("enriches legacy Automation sources on command outcomes before the first list request", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-automation-outcome-ipc-"));
  const missions = createMissionStore({ missionsPath: join(root, "missions") });
  const subscribeCommandOutcomes = vi.fn();
  const send = vi.fn();
  try {
    const mission = await missions.create({
      workspace: { path: root, basename: "workspace" },
      goal: "Existing automation",
      project: { id: "studio", revision: 1 },
      executor: { kind: "expert", ref: "expert:t9ne4d8njvvxv2ea", name: "Expert" },
    });
    const automationRef = "automation:m9a8n9nxvvyb4j01";
    const getAutomationMissionSources = vi.fn(async () => new Map([[mission.id, automationRef]]));
    installMissionHandlers({
      missions,
      localHost: { getMission: (id: string) => missions.get(id) },
      application: {
        subscribeCommandOutcomes,
        subscribeChat: vi.fn(),
        subscribeStatus: vi.fn(),
        subscribeWork: vi.fn(),
        subscribeWorkConversationStreams: vi.fn(),
      },
      getAutomationMissionSources,
      getWindow: () => ({ webContents: { send } }),
      temporaryRoot: join(root, "tmp"),
    } as unknown as Parameters<typeof installMissionHandlers>[0]);
    subscribeCommandOutcomes.mock.calls[0]![0]({
      missionId: mission.id,
      requestId: "request",
      state: "applied",
    });
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        "missions:updated",
        expect.objectContaining({
          kind: "upsert",
          mission: expect.objectContaining({ id: mission.id }),
          source: { type: "automation", automationRef },
        }),
      ),
    );
    expect(getAutomationMissionSources).toHaveBeenCalledOnce();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
