import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createLocalHostMissionApplication,
  createLocalHostMissionController,
  MissionExecutionOwner,
} from "@pragma/local-host";
import { describe, expect, it, vi } from "vitest";
import { installDesktopShutdown } from "./shutdown-sequence.ts";

function fixture(dispose: () => Promise<void>) {
  let beforeQuit: (event: { preventDefault(): void }) => void = () => undefined;
  const quit = vi.fn();
  const reportFailure = vi.fn();
  installDesktopShutdown({
    app: {
      on: (_event, listener) => (beforeQuit = listener),
      quit,
    },
    dispose,
    reportFailure,
  });
  return {
    quit,
    reportFailure,
    requestQuit: () => {
      const preventDefault = vi.fn();
      beforeQuit({ preventDefault });
      return preventDefault;
    },
  };
}

describe("Desktop actual quit adapter", () => {
  it("waits for shared shutdown and joins repeated quit requests before permitting Electron exit", async () => {
    let complete = () => undefined as void;
    const pending = new Promise<void>((resolve) => (complete = resolve));
    const dispose = vi.fn(() => pending);
    const f = fixture(dispose);
    expect(f.requestQuit()).toHaveBeenCalledOnce();
    expect(f.requestQuit()).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(f.quit).not.toHaveBeenCalled();
    complete();
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(f.requestQuit()).not.toHaveBeenCalled();
    expect(f.reportFailure).not.toHaveBeenCalled();
  });

  it("keeps Electron alive after unconfirmed Native stop and permits a later shutdown retry", async () => {
    const failure = new Error("Native owner retained");
    const dispose = vi.fn().mockRejectedValueOnce(failure).mockResolvedValue(undefined);
    const f = fixture(dispose);
    f.requestQuit();
    await vi.waitFor(() => expect(f.reportFailure).toHaveBeenCalledWith(failure));
    expect(f.quit).not.toHaveBeenCalled();
    expect(f.requestQuit()).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(dispose).toHaveBeenCalledTimes(2);
  });
});

it("the Electron adapter retains real shared Host lease and resources until Native stop confirms", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-desktop-quit-"));
  const lifecycle = createLocalHostMissionController({ missionsPath: root });
  const owners = new MissionExecutionOwner();
  const closeResources = vi.fn(async () => undefined);
  let executionStatus = "running";
  const stopForDeletion = vi.fn(async (): Promise<void> => {
    throw new Error("Native stop unconfirmed");
  });
  const application = createLocalHostMissionApplication({
    lifecycle,
    closeResources,
    client: { surface: "desktop", version: "test", instanceId: randomUUID() },
    resolveExecutor: async () => undefined,
    execution: {
      pragmaHome: root,
      executionOwner: owners as Parameters<
        typeof createLocalHostMissionApplication
      >[0]["execution"]["executionOwner"],
      resourcePorts: { createCompileService: () => ({}) as never } as never,
      missions: {} as never,
      executionStore: {
        get: async () => ({ status: executionStatus }),
        listInvocations: async () => [],
      } as never,
      expertSessionStore: {} as never,
      runtimes: {} as never,
    },
  });
  const missionId = randomUUID();
  const f = fixture(application.dispose);
  try {
    const guard = await lifecycle.ownerScope.acquire(missionId);
    owners.setControlOwner(
      missionId,
      {
        kind: "flow",
        execution: { executionId: randomUUID(), stopForDeletion } as never,
      },
      "live",
    );
    f.requestQuit();
    await vi.waitFor(() => expect(f.reportFailure).toHaveBeenCalledOnce());
    expect(f.quit).not.toHaveBeenCalled();
    expect(closeResources).not.toHaveBeenCalled();
    expect((await lifecycle.controller.readSnapshot({ missionId })).snapshot.lease?.claimId).toBe(
      guard.claimId,
    );
    expect(owners.controlOwner(missionId)).toBeDefined();
    stopForDeletion.mockImplementation(async () => {
      executionStatus = "cancelled";
    });
    f.requestQuit();
    await vi.waitFor(() => expect(f.quit).toHaveBeenCalledOnce());
    expect(closeResources).toHaveBeenCalledOnce();
    expect(owners.controlOwner(missionId)).toBeUndefined();
    expect((await lifecycle.controller.readSnapshot({ missionId })).snapshot.lease).toBeUndefined();
  } finally {
    stopForDeletion.mockImplementation(async () => {
      executionStatus = "cancelled";
    });
    await application.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
