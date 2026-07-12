import { SessionManager } from "@earendil-works/pi-coding-agent";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { createPiSessionManager, getPiSessionDir } from "../src/session-manager.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(),
  },
  ModelRegistry: {
    create: vi.fn(),
  },
  SessionManager: {
    create: vi.fn((cwd: string, sessionDir: string | undefined, options: unknown) => ({
      cwd,
      options,
      sessionDir,
      type: "create",
    })),
    inMemory: vi.fn((cwd: string) => ({
      cwd,
      type: "inMemory",
    })),
    list: vi.fn(),
    listAll: vi.fn(),
    open: vi.fn((path: string, sessionDir: string | undefined, cwd: string | undefined) => ({
      cwd,
      path,
      sessionDir,
      type: "open",
    })),
  },
  createAgentSession: vi.fn(),
}));

describe("createPiSessionManager", () => {
  beforeEach(() => {
    vi.mocked(SessionManager.create).mockClear();
    vi.mocked(SessionManager.inMemory).mockClear();
    vi.mocked(SessionManager.list).mockReset();
    vi.mocked(SessionManager.listAll).mockReset();
    vi.mocked(SessionManager.open).mockClear();
  });

  it("creates a workflow-owned session when no session id is provided", async () => {
    const result = await createPiSessionManager("/workspace", "/pragma/runtime/pi", undefined);

    expect(result).toEqual({
      sessionManager: {
        cwd: "/workspace",
        options: undefined,
        sessionDir: "/pragma/runtime/pi/sessions",
        type: "create",
      },
      resumedExistingSession: false,
    });
    expect(SessionManager.create).toHaveBeenCalledWith("/workspace", "/pragma/runtime/pi/sessions");
    expect(SessionManager.inMemory).not.toHaveBeenCalled();
    expect(SessionManager.list).not.toHaveBeenCalled();
  });

  it("opens an existing local session with the requested session id", async () => {
    vi.mocked(SessionManager.listAll).mockResolvedValue([
      createSessionInfo({
        id: "session-1",
        path: "/sessions/session-1.jsonl",
      }),
      createSessionInfo({
        id: "session-2",
        path: "/sessions/session-2.jsonl",
      }),
    ]);

    const result = await createPiSessionManager("/workspace", "/pragma/runtime/pi", "session-2");

    expect(result).toEqual({
      sessionManager: {
        cwd: "/workspace",
        path: "/sessions/session-2.jsonl",
        sessionDir: "/pragma/runtime/pi/sessions",
        type: "open",
      },
      resumedExistingSession: true,
    });
    expect(SessionManager.list).not.toHaveBeenCalled();
    expect(SessionManager.listAll).toHaveBeenCalledWith("/pragma/runtime/pi/sessions");
    expect(SessionManager.open).toHaveBeenCalledWith(
      "/sessions/session-2.jsonl",
      "/pragma/runtime/pi/sessions",
      "/workspace",
    );
    expect(SessionManager.create).not.toHaveBeenCalled();
  });

  it("rejects a requested runtime session when none exists", async () => {
    vi.mocked(SessionManager.listAll).mockResolvedValue([]);

    await expect(
      createPiSessionManager("/workspace", "/pragma/runtime/pi", "session-3"),
    ).rejects.toThrow("PI runtime session was not found: session-3.");
    expect(SessionManager.create).not.toHaveBeenCalled();
    expect(SessionManager.list).not.toHaveBeenCalled();
    expect(SessionManager.listAll).toHaveBeenCalledWith("/pragma/runtime/pi/sessions");
    expect(SessionManager.open).not.toHaveBeenCalled();
  });

  it("places native sessions below the PI runtime directory", () => {
    expect(getPiSessionDir("/pragma/runtime/pi")).toBe("/pragma/runtime/pi/sessions");
  });
});

function createSessionInfo(options: { readonly id: string; readonly path: string }) {
  return {
    allMessagesText: "",
    created: new Date("2026-01-01T00:00:00.000Z"),
    cwd: "/workspace",
    firstMessage: "",
    id: options.id,
    messageCount: 0,
    modified: new Date("2026-01-01T00:00:00.000Z"),
    path: options.path,
  };
}
