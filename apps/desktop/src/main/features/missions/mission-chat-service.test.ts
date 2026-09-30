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
