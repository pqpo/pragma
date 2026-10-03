import { describe, expect, it, vi } from "vitest";
import { createMissionRequestResourceRelease } from "../../src/missions/request-resource-release.ts";

describe("request resource lifetime", () => {
  it("waits for Session processing before releasing the owner and releases once", async () => {
    let finishProcessing!: () => void;
    const processing = new Promise<void>((resolve) => {
      finishProcessing = resolve;
    });
    const released: string[] = [];
    const release = createMissionRequestResourceRelease({
      enabled: true,
      admit: async (operation) => await operation(),
      isCurrent: () => true,
      releaseSession: async () => {
        await processing;
        released.push("session");
      },
      detach: () => {
        released.push("detach");
      },
      releaseOwner: async () => {
        released.push("owner");
      },
    });
    const first = release();
    const duplicate = release();
    await Promise.resolve();
    expect(released).toEqual([]);
    finishProcessing();
    await Promise.all([first, duplicate]);
    expect(released).toEqual(["session", "detach", "owner"]);
  });

  it("does not release a successor from a late callback", async () => {
    const releaseSession = vi.fn();
    const detach = vi.fn();
    const releaseOwner = vi.fn();
    const release = createMissionRequestResourceRelease({
      enabled: true,
      admit: async (operation) => await operation(),
      isCurrent: () => false,
      releaseSession,
      detach,
      releaseOwner,
    });
    await release();
    expect(releaseSession).not.toHaveBeenCalled();
    expect(detach).not.toHaveBeenCalled();
    expect(releaseOwner).not.toHaveBeenCalled();
  });

  it("retains host resources for warm continuation", async () => {
    const admit = vi.fn();
    await createMissionRequestResourceRelease({
      enabled: false,
      admit,
      isCurrent: () => true,
      releaseSession: vi.fn(),
      detach: vi.fn(),
      releaseOwner: vi.fn(),
    })();
    expect(admit).not.toHaveBeenCalled();
  });
});

it("retains the lease until the necessary terminal write commits", async () => {
  let finishCommit!: () => void;
  const terminal = new Promise<void>((resolve) => {
    finishCommit = resolve;
  });
  const releaseSession = vi.fn();
  const releaseOwner = vi.fn();
  const release = createMissionRequestResourceRelease({
    enabled: true,
    admit: async (operation) => await operation(),
    isCurrent: () => true,
    waitForDurableTerminal: async () => await terminal,
    releaseSession,
    detach: vi.fn(),
    releaseOwner,
  });
  const completion = release();
  await Promise.resolve();
  expect(releaseSession).not.toHaveBeenCalled();
  expect(releaseOwner).not.toHaveBeenCalled();
  finishCommit();
  await completion;
  expect(releaseSession).toHaveBeenCalledOnce();
  expect(releaseOwner).toHaveBeenCalledOnce();
});

it("keeps the lease when a necessary terminal write is rejected by fencing", async () => {
  const failure = { code: "MISSION_FENCING_REJECTED", message: "Controller lease superseded" };
  const releaseSession = vi.fn();
  const releaseOwner = vi.fn();
  const detach = vi.fn();
  const release = createMissionRequestResourceRelease({
    enabled: true,
    admit: async (operation) => await operation(),
    isCurrent: () => true,
    waitForDurableTerminal: async () => {
      throw failure;
    },
    releaseSession,
    detach,
    releaseOwner,
  });
  await expect(release()).rejects.toBe(failure);
  expect(releaseSession).not.toHaveBeenCalled();
  expect(detach).not.toHaveBeenCalled();
  expect(releaseOwner).not.toHaveBeenCalled();
});
