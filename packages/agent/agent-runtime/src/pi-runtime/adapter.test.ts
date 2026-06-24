import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { createAgentSession } from "@earendil-works/pi-coding-agent";
import { ExpertAgent } from "@expertmesh/agent-core";
import type { ExpertAgentRunContext } from "@expertmesh/agent-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createCloudPiRuntimeAdapter } from "./adapter.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
  AuthStorage: {
    create: vi.fn(() => ({})),
  },
  DefaultResourceLoader: class {
    async reload() {
      return undefined;
    }
  },
  ModelRegistry: {
    create: vi.fn(() => ({
      getAll: () => [],
    })),
  },
  SessionManager: {
    create: vi.fn(() => ({})),
    inMemory: vi.fn(() => ({})),
    list: vi.fn(async () => []),
    open: vi.fn(() => ({})),
  },
  createAgentSession: vi.fn(),
  createSyntheticSourceInfo: vi.fn(() => ({})),
  getAgentDir: vi.fn(() => "/tmp/expertmesh-agent-dir"),
}));

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("createCloudPiRuntimeAdapter", () => {
  beforeEach(() => {
    vi.mocked(createAgentSession).mockReset();
  });

  it("runs session destroy hooks when PI session creation fails", async () => {
    const events: string[] = [];
    let sessionContext: ExpertAgentRunContext | undefined;
    const workspace = await createTempDir();
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "agent-1",
      displayName: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
      hooks: {
        beforeSessionCreate: ({ context }) => {
          sessionContext = context;
          events.push("beforeSessionCreate");
        },
        beforeSessionDestroy: () => {
          events.push("beforeSessionDestroy");
        },
        afterSessionDestroy: () => {
          events.push("afterSessionDestroy");
        },
      },
    });
    vi.mocked(createAgentSession).mockRejectedValue(new Error("PI session failed"));

    await expect(createCloudPiRuntimeAdapter().createSession({ agent })).rejects.toThrow(
      "PI session failed",
    );

    expect(events).toEqual([
      "beforeSessionCreate",
      "beforeSessionDestroy",
      "afterSessionDestroy",
    ]);
    expect(sessionContext).toEqual({
      source: {
        type: "system",
      },
      attributes: {},
    });
  });

  it("merges supplied run context before creating the lifecycle", async () => {
    let sessionContext: ExpertAgentRunContext | undefined;
    const workspace = await createTempDir();
    const agent = await ExpertAgent.create({
      schemaVersion: "expertmesh.expert/v1",
      id: "agent-1",
      displayName: "Test Agent",
      description: "Agent for runtime adapter tests.",
      tags: ["test"],
      version: "0.0.0",
      scope: "test",
      workspace,
      hooks: {
        beforeSessionCreate: ({ context }) => {
          sessionContext = context;
        },
      },
    });
    vi.mocked(createAgentSession).mockRejectedValue(new Error("PI session failed"));

    await expect(
      createCloudPiRuntimeAdapter().createSession({
        agent,
        context: {
          source: {
            type: "user",
            id: "user-1",
          },
          attributes: {
            tenantId: "tenant-1",
          },
        },
      }),
    ).rejects.toThrow("PI session failed");

    expect(sessionContext).toEqual({
      source: {
        type: "user",
        id: "user-1",
      },
      attributes: {
        tenantId: "tenant-1",
      },
    });
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(resolve(tmpdir(), "expertmesh-pi-adapter-"));
  tempDirs.push(dir);
  return dir;
}
