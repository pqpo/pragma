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
    const manager = await createPiSessionManager(
      "/workspace",
      "expert-1",
      undefined,
      "cloud-pi-agent",
    );

    expect(manager).toEqual({
      cwd: "/workspace",
      options: undefined,
      sessionDir: "/workspace/.pragma/runtime-sessions/pi/expert-1",
      type: "create",
    });
    expect(SessionManager.create).toHaveBeenCalledWith(
      "/workspace",
      "/workspace/.pragma/runtime-sessions/pi/expert-1",
    );
    expect(SessionManager.inMemory).not.toHaveBeenCalled();
    expect(SessionManager.list).not.toHaveBeenCalled();
  });

  it("creates a new session when the requested runtime session type does not match", async () => {
    const manager = await createPiSessionManager(
      "/workspace",
      "expert-1",
      {
        type: "other-runtime",
        id: "session-2",
      },
      "cloud-pi-agent",
    );

    expect(manager).toEqual({
      cwd: "/workspace",
      options: undefined,
      sessionDir: "/workspace/.pragma/runtime-sessions/pi/expert-1",
      type: "create",
    });
    expect(SessionManager.create).toHaveBeenCalledWith(
      "/workspace",
      "/workspace/.pragma/runtime-sessions/pi/expert-1",
    );
    expect(SessionManager.list).not.toHaveBeenCalled();
    expect(SessionManager.open).not.toHaveBeenCalled();
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

    const manager = await createPiSessionManager(
      "/workspace",
      "expert-1",
      {
        type: "cloud-pi-agent",
        id: "session-2",
      },
      "cloud-pi-agent",
    );

    expect(manager).toEqual({
      cwd: "/workspace",
      path: "/sessions/session-2.jsonl",
      sessionDir: "/workspace/.pragma/runtime-sessions/pi/expert-1",
      type: "open",
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

  it("creates a persistent session with the requested session id when none exists", async () => {
    vi.mocked(SessionManager.listAll).mockResolvedValue([]);

    const manager = await createPiSessionManager(
      "/workspace",
      "expert-1",
      {
        type: "cloud-pi-agent",
        id: "session-3",
      },
      "cloud-pi-agent",
    );

    expect(manager).toEqual({
      cwd: "/workspace",
      options: {
        id: "session-3",
      },
      sessionDir: "/workspace/.pragma/runtime-sessions/pi/expert-1",
      type: "create",
    });
    expect(SessionManager.create).toHaveBeenCalledWith(
      "/workspace",
      "/workspace/.pragma/runtime-sessions/pi/expert-1",
      {
        id: "session-3",
      },
    );
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
