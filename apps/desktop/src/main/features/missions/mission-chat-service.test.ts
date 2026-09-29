import { expect, it } from "vitest";

import { MissionChatService } from "./mission-chat-service.ts";

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
