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

  it("creates a workspace-persisted session when no session id is provided", async () => {
    const result = await createPiSessionManager("/workspace", "expert-1", undefined);

    expect(result).toEqual({
      sessionManager: {
        cwd: "/workspace",
        options: undefined,
        sessionDir: "/workspace/.pragma/runtime-sessions/pi/expert-1",
        type: "create",
      },
      resumedExistingSession: false,
    });
    expect(SessionManager.create).toHaveBeenCalledWith(
      "/workspace",
      "/workspace/.pragma/runtime-sessions/pi/expert-1",
    );
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

    const result = await createPiSessionManager("/workspace", "expert-1", "session-2");

    expect(result).toEqual({
      sessionManager: {
        cwd: "/workspace",
        path: "/sessions/session-2.jsonl",
        sessionDir: "/workspace/.pragma/runtime-sessions/pi/expert-1",
        type: "open",
      },
      resumedExistingSession: true,
    });
    expect(SessionManager.list).not.toHaveBeenCalled();
    expect(SessionManager.listAll).toHaveBeenCalledWith(
      "/workspace/.pragma/runtime-sessions/pi/expert-1",
    );
    expect(SessionManager.open).toHaveBeenCalledWith(
      "/sessions/session-2.jsonl",
      "/workspace/.pragma/runtime-sessions/pi/expert-1",
      "/workspace",
    );
    expect(SessionManager.create).not.toHaveBeenCalled();
  });

  it("rejects a requested runtime session when none exists", async () => {
    vi.mocked(SessionManager.listAll).mockResolvedValue([]);

    await expect(createPiSessionManager("/workspace", "expert-1", "session-3")).rejects.toThrow(
      "PI runtime session was not found: session-3.",
    );
    expect(SessionManager.create).not.toHaveBeenCalled();
    expect(SessionManager.list).not.toHaveBeenCalled();
    expect(SessionManager.listAll).toHaveBeenCalledWith(
      "/workspace/.pragma/runtime-sessions/pi/expert-1",
    );
    expect(SessionManager.open).not.toHaveBeenCalled();
  });

  it("encodes expert ids in the workspace session directory", () => {
    expect(getPiSessionDir("/workspace", "team/reviewer")).toBe(
      "/workspace/.pragma/runtime-sessions/pi/team%2Freviewer",
    );
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
