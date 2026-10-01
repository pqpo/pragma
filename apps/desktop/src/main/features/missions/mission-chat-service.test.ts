import { expect, it } from "vitest";

import { MissionChatService } from "./mission-chat-service.ts";

it("tracks history invalidations separately from live text patches and clears both watermarks", async () => {
  const service = new MissionChatService(() => undefined);
  service.invalidate("mission", "user");
  expect(service.invalidationRevision("mission")).toBe(1);
  service.emitPatches("mission", "user", [
    { type: "entry.append", entryId: "reply", field: "content", delta: "continued" },
  ]);
  expect(service.revision("mission")).toBe(2);
  expect(service.invalidationRevision("mission")).toBe(1);
  service.invalidate("mission", "user");
  expect(service.invalidationRevision("mission")).toBe(3);
  expect(service.invalidationRevision("other-mission")).toBe(0);
  await service.clear("mission");
  expect(service.revision("mission")).toBe(0);
  expect(service.invalidationRevision("mission")).toBe(0);
});

it("keeps the new live projection when the previous close finishes late", async () => {
  let releaseClose!: () => void;
  const closeGate = new Promise<void>((resolve) => {
    releaseClose = resolve;
  });
  const service = new MissionChatService(() => undefined);
  const previous = { close: async () => await closeGate };
  const next = { close: async () => undefined };
  service.setLive("mission", previous);
  const closing = service.closeLiveIfCurrent("mission", previous);
  service.setLive("mission", next);
  releaseClose();
  await closing;
  expect(service.live("mission")).toBe(next);
});

it("coalesces only identical pending reads and separates new revisions and audiences", async () => {
  const service = new MissionChatService(() => undefined);
  let finish!: (value: number) => void;
  let loads = 0;
  const load = () => {
    loads++;
    return new Promise<number>((resolve) => {
      finish = resolve;
    });
  };
  const first = service.read("mission", "user", "history", { limit: 50 }, load);
  const same = service.read("mission", "user", "history", { limit: 50 }, load);
  expect(first).toBe(same);
  await Promise.resolve();
  expect(loads).toBe(1);
  const oldFinish = finish;
  service.invalidate("mission", "user");
  const newer = service.read("mission", "user", "history", { limit: 50 }, async () => 2);
  const internal = service.read("mission", "internal", "history", { limit: 50 }, async () => 3);
  oldFinish(1);
  await expect(first).resolves.toBe(1);
  await expect(newer).resolves.toBe(2);
  await expect(internal).resolves.toBe(3);
  await expect(
    service.read("mission", "user", "history", { limit: 50 }, async () => 4),
  ).resolves.toBe(4);
});

it("removes failed reads and fences reads across deletion without invalidating another Mission", async () => {
  const service = new MissionChatService(() => undefined);
  await expect(
    service.read("mission", "user", "state", null, async () => {
      throw new Error("unavailable");
    }),
  ).rejects.toThrow("unavailable");
  let finish!: () => void;
  const old = service.read(
    "mission",
    "user",
    "state",
    null,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const other = service.read("other", "user", "state", null, async () => 9);
  await Promise.resolve();
  const observed = expect(old).rejects.toThrow("superseded");
  await service.clear("mission");
  finish();
  await observed;
  await expect(other).resolves.toBe(9);
  await expect(service.read("mission", "user", "state", null, async () => 10)).resolves.toBe(10);
});

it("fences owner-close reads while preserving the live revision and projection", async () => {
  const service = new MissionChatService(() => undefined);
  const live = { close: async () => undefined };
  service.setLive("mission", live);
  service.invalidate("mission", "user");
  let finish!: () => void;
  const pending = service.read(
    "mission",
    "user",
    "control",
    null,
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  await Promise.resolve();
  const observed = expect(pending).rejects.toThrow("superseded");
  service.clearReads("mission");
  finish();
  await observed;
  expect(service.revision("mission")).toBe(1);
  expect(service.live("mission")).toBe(live);
  await expect(service.read("mission", "user", "control", null, async () => 2)).resolves.toBe(2);
});
