import { expect, it } from "vitest";
import { MissionSessionService } from "./mission-session-service.ts";

it("keeps the message gate closed until all concurrent teammate mounts finish", () => {
  const sessions = new MissionSessionService();
  sessions.beginContextBindingChange("mission");
  sessions.beginContextBindingChange("mission");
  sessions.finishContextBindingChange("mission");
  expect(sessions.contextBindingChangeInProgress("mission")).toBe(true);
  expect(sessions.contextBindingChangeInProgress("other")).toBe(false);
  sessions.finishContextBindingChange("mission");
  expect(sessions.contextBindingChangeInProgress("mission")).toBe(false);
});
