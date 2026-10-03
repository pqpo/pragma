import { describe, expect, it, vi } from "vitest";
import { createMissionSessionAssociationResolver } from "../src/missions/session-association.ts";

function fixture() {
  const controller = {
    readSnapshot: vi.fn().mockResolvedValue({
      snapshot: {
        operations: {
          send: {
            commandId: "send-command",
            kind: "send",
            result: { executionId: "successor-turn" },
          },
        },
      },
      events: [
        { type: "run.started", data: { executionId: "original-turn" } },
        { type: "command.applied", data: { commandId: "send-command" } },
        { type: "run.succeeded", data: { executionId: "original-turn" } },
      ],
    }),
  };
  const executions = {
    get: vi.fn().mockResolvedValue({ kind: "expert-turn", rootInvocationId: "root" }),
    getInvocation: vi.fn().mockResolvedValue({ contextId: "original-context" }),
    getContext: vi.fn().mockResolvedValue({
      schemaVersion: "pragma.runtime-context/v5",
      contextId: "original-context",
      owner: { type: "expert-session", ownerId: "successor-session" },
      origin: { type: "expert-session", sessionId: "successor-session" },
      expert: { id: "expert" },
      runtime: { runtimeId: "runtime", revision: 1, fingerprint: "a".repeat(64) },
      snapshot: {
        systemSessionId: "original-system-session",
        runtimeSession: { type: "runtime", id: "native-session" },
      },
      lifecycle: "open",
      createdAt: "2026-10-03T00:00:00Z",
      updatedAt: "2026-10-03T00:00:00Z",
    }),
  };
  const sessions = { get: vi.fn().mockResolvedValue(undefined) };
  return { controller, executions, sessions };
}

describe("Mission Session association", () => {
  it("reads a persisted run Session association before Runtime Context creation", async () => {
    const ports = fixture();
    ports.controller.readSnapshot.mockResolvedValue({
      snapshot: { operations: {} },
      events: [
        { type: "run.started", data: { executionId: "initial-turn", sessionId: "actual-session" } },
      ],
    });
    ports.sessions.get.mockResolvedValue({ sessionId: "actual-session" });
    expect(await createMissionSessionAssociationResolver(ports)("mission")).toBe("actual-session");
    expect(ports.sessions.get).toHaveBeenCalledExactlyOnceWith("actual-session");
    expect(ports.executions.get).not.toHaveBeenCalled();
  });

  it("reads the accepted successor's root without following late original terminal callbacks", async () => {
    const ports = fixture();
    const resolve = createMissionSessionAssociationResolver(ports);
    expect(await resolve("mission")).toBe("successor-session");
    expect(ports.executions.get).toHaveBeenCalledExactlyOnceWith("successor-turn");
    expect(ports.executions.getContext).toHaveBeenCalledExactlyOnceWith(
      "successor-turn",
      "original-context",
    );
    expect(ports.sessions.get).not.toHaveBeenCalled();
  });

  it("prefers accepted successor association over a later recovery run projection", async () => {
    const ports = fixture();
    ports.controller.readSnapshot.mockResolvedValue({
      snapshot: {
        operations: {
          send: {
            commandId: "send-command",
            kind: "send",
            result: { executionId: "successor-turn", sessionId: "successor-session" },
          },
        },
      },
      events: [
        { type: "command.applied", data: { commandId: "send-command" } },
        {
          type: "run.started",
          data: { executionId: "original-turn", sessionId: "original-session" },
        },
      ],
    });
    ports.sessions.get.mockResolvedValue({ sessionId: "successor-session" });
    expect(await createMissionSessionAssociationResolver(ports)("mission")).toBe(
      "successor-session",
    );
    expect(ports.sessions.get).toHaveBeenCalledExactlyOnceWith("successor-session");
    expect(ports.executions.get).not.toHaveBeenCalled();
  });

  it("prefers the repository's named Session without reading the controller or unrelated owners", async () => {
    const ports = fixture();
    const resolve = createMissionSessionAssociationResolver({
      ...ports,
      repositorySessionId: async () => "repository-session",
    });
    expect(await resolve("mission")).toBe("repository-session");
    expect(ports.controller.readSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a corrupt or future Context instead of returning the original Mission Session", async () => {
    const ports = fixture();
    ports.executions.getContext.mockResolvedValue({ schemaVersion: "pragma.runtime-context/v99" });
    await expect(createMissionSessionAssociationResolver(ports)("mission")).rejects.toThrow();
    expect(ports.sessions.get).not.toHaveBeenCalled();
  });

  it("retains a named queued legacy Session before Runtime Context creation", async () => {
    const ports = fixture();
    ports.executions.getContext.mockResolvedValue(undefined);
    ports.sessions.get.mockResolvedValue({
      sessionId: "mission",
      executionIds: ["successor-turn"],
    });
    expect(await createMissionSessionAssociationResolver(ports)("mission")).toBe("mission");
  });

  it("refuses a missing association to an unrelated original Session", async () => {
    const ports = fixture();
    ports.executions.getContext.mockResolvedValue(undefined);
    ports.sessions.get.mockResolvedValue({ sessionId: "mission", executionIds: ["original-turn"] });
    await expect(createMissionSessionAssociationResolver(ports)("mission")).rejects.toMatchObject({
      details: { reason: "session_association_invalid" },
    });
  });
});
