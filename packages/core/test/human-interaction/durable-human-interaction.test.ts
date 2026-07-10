import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  ResolvedHumanInteractionSchema,
  createDurableHumanInteractionHandler,
  createFileHumanInteractionStore,
} from "@pragma/core";
import type {
  ExpertAgentHumanRequest,
  ExpertAgentHumanResponse,
  HumanInteractionScope,
  ResolvedHumanInteraction,
} from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

const request = {
  kind: "tool_approval",
  toolName: "deploy_preview",
  toolCallId: "tool-call-1",
  reason: "Needs approval.",
  input: {
    environment: "preview",
  },
} satisfies ExpertAgentHumanRequest;

const approved = {
  kind: "tool_approval",
  approved: true,
} satisfies ExpertAgentHumanResponse;

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("durable human interaction", () => {
  it("persists a pending interaction before delegating and resolves it after response", async () => {
    const rootDir = await createTempDir();
    const store = createFileHumanInteractionStore({ rootDir });
    const scope = createScope();
    const handler = createDurableHumanInteractionHandler({
      scope,
      store,
      delegate: async () => {
        const pending = await store.getPending(scope);

        expect(pending).toMatchObject({
          scope,
          request,
          status: "pending",
          attempts: 1,
        });

        return approved;
      },
    });

    await expect(handler(request)).resolves.toEqual(approved);
    await expect(store.listPending(scope)).resolves.toEqual([]);
  });

  it("leaves the pending interaction available when the delegate is interrupted", async () => {
    const rootDir = await createTempDir();
    const store = createFileHumanInteractionStore({ rootDir });
    const scope = createScope();
    const handler = createDurableHumanInteractionHandler({
      scope,
      store,
      delegate: async () => {
        throw new Error("interrupted");
      },
    });

    await expect(handler(request)).rejects.toThrow("interrupted");

    const pending = await store.getPending(scope);
    expect(pending).toMatchObject({
      scope,
      request,
      status: "pending",
      attempts: 1,
    });
  });

  it("reuses an existing pending interaction for the same request", async () => {
    const rootDir = await createTempDir();
    const store = createFileHumanInteractionStore({ rootDir });
    const scope = createScope();
    const interrupted = createDurableHumanInteractionHandler({
      scope,
      store,
      delegate: async () => {
        throw new Error("interrupted");
      },
    });

    await expect(interrupted(request)).rejects.toThrow("interrupted");

    const resumed = createDurableHumanInteractionHandler({
      scope,
      store,
      delegate: async () => {
        const pending = await store.getPending(scope);
        expect(pending?.attempts).toBe(2);

        return approved;
      },
    });

    await expect(resumed(request)).resolves.toEqual(approved);
    await expect(store.listPending(scope)).resolves.toEqual([]);
  });

  it("reuses a pending tool approval when a restored runtime regenerates the tool call id", async () => {
    const rootDir = await createTempDir();
    const store = createFileHumanInteractionStore({ rootDir });
    const scope = createScope();
    const interrupted = createDurableHumanInteractionHandler({
      scope,
      store,
      createInteractionId: () => "approval-1",
      delegate: async () => {
        throw new Error("interrupted");
      },
    });

    await expect(interrupted(request)).rejects.toThrow("interrupted");

    const regeneratedRequest = {
      ...request,
      toolCallId: "tool-call-after-restore",
    } satisfies ExpertAgentHumanRequest;
    const resumed = createDurableHumanInteractionHandler({
      scope,
      store,
      delegate: async () => approved,
    });

    await expect(resumed(regeneratedRequest)).resolves.toEqual(approved);
    await expect(store.listPending(scope)).resolves.toEqual([]);

    const resolved = await readResolvedInteractions(rootDir);
    expect(resolved).toMatchObject([
      {
        id: "approval-1",
        attempts: 2,
        request: regeneratedRequest,
      },
    ]);
  });

  it("filters pending interactions by scope", async () => {
    const rootDir = await createTempDir();
    const store = createFileHumanInteractionStore({ rootDir });
    const leftScope = createScope("workflow-left", "session-left");
    const rightScope = createScope("workflow-right", "session-right");

    await createDurableHumanInteractionHandler({
      scope: leftScope,
      store,
      delegate: async () => {
        throw new Error("left pending");
      },
    })(request).catch(() => undefined);
    await createDurableHumanInteractionHandler({
      scope: rightScope,
      store,
      delegate: async () => {
        throw new Error("right pending");
      },
    })(request).catch(() => undefined);

    await expect(store.listPending(leftScope)).resolves.toHaveLength(1);
    await expect(store.listPending(rightScope)).resolves.toHaveLength(1);
    await expect(store.listPending({ workflowId: "missing" })).resolves.toHaveLength(0);
  });

  it("keeps file store methods usable when destructured", async () => {
    const rootDir = await createTempDir();
    const store = createFileHumanInteractionStore({ rootDir });
    const scope = createScope();
    const { getPending, resolve } = store;

    await createDurableHumanInteractionHandler({
      scope,
      store,
      delegate: async () => {
        throw new Error("interrupted");
      },
    })(request).catch(() => undefined);

    const pending = await getPending(scope);
    if (pending === undefined) {
      throw new Error("Expected pending human interaction.");
    }
    expect(pending).toMatchObject({
      scope,
      request,
      status: "pending",
    });

    await resolve(pending.id, approved);
    await expect(store.listPending(scope)).resolves.toEqual([]);
  });

  it("does not list a pending file after the same interaction was resolved", async () => {
    const rootDir = await createTempDir();
    const store = createFileHumanInteractionStore({ rootDir });
    const scope = createScope();

    await createDurableHumanInteractionHandler({
      scope,
      store,
      delegate: async () => {
        throw new Error("interrupted");
      },
    })(request).catch(() => undefined);

    const pending = await store.getPending(scope);
    if (pending === undefined) {
      throw new Error("Expected pending human interaction.");
    }

    await store.resolve(pending.id, approved);
    await store.savePending(pending);

    await expect(store.listPending(scope)).resolves.toEqual([]);
  });

  it("uses configured interaction ids for new pending interactions", async () => {
    const rootDir = await createTempDir();
    const store = createFileHumanInteractionStore({ rootDir });
    const scope = createScope();

    await createDurableHumanInteractionHandler({
      scope,
      store,
      createInteractionId: () => "approval-1",
      delegate: async () => {
        throw new Error("interrupted");
      },
    })(request).catch(() => undefined);

    await expect(store.getPending(scope)).resolves.toMatchObject({
      id: "approval-1",
    });
  });

  it("uses configured clocks for pending and resolved timestamps", async () => {
    const rootDir = await createTempDir();
    const scope = createScope();
    const pendingAt = new Date("2026-01-02T03:04:05.000Z");
    const resolvedAt = new Date("2026-01-02T03:05:06.000Z");
    const store = createFileHumanInteractionStore({
      rootDir,
      now: () => resolvedAt,
    });

    await createDurableHumanInteractionHandler({
      scope,
      store,
      now: () => pendingAt,
      delegate: async () => approved,
    })(request);

    const resolved = await readResolvedInteractions(rootDir);
    expect(resolved).toMatchObject([
      {
        createdAt: pendingAt.toISOString(),
        updatedAt: resolvedAt.toISOString(),
        resolvedAt: resolvedAt.toISOString(),
      },
    ]);
  });
});

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pragma-human-interaction-"));
  tempDirs.push(dir);

  return dir;
}

function createScope(
  workflowId = "workflow-1",
  runtimeSessionId = "runtime-session-1",
): HumanInteractionScope {
  return {
    workflowId,
    runtimeSessionId,
  };
}

async function readResolvedInteractions(
  rootDir: string,
): Promise<ResolvedHumanInteraction[]> {
  const resolvedDir = join(rootDir, "resolved");
  const entries = await readdir(resolvedDir);

  return await Promise.all(
    entries
      .filter((entry) => entry.endsWith(".json"))
      .map(async (entry) =>
        ResolvedHumanInteractionSchema.parse(
          JSON.parse(await readFile(join(resolvedDir, entry), "utf8")),
        ),
      ),
  );
}
