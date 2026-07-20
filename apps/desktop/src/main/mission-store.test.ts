import { appendFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import type { PragmaExpertResource } from "@pragma/interpreter/ast";
import { missionExecutorSnapshot } from "../shared/desktop-api.ts";
import { createMissionStore } from "./mission-store.ts";

const temporaryPaths: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

describe("mission store", () => {
  it("persists a mission pinned to an immutable project revision", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const expert = expertFixture();

    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Design the Missions experience\nwith a second line.",
      project: { id: "studio", revision: 3 },
      executor: missionExecutorSnapshot(expert),
      toolPermissionMode: "full-access",
      modelOverride: {
        providerId: "provider",
        modelId: "configured-model",
        thinkingLevel: "high",
      },
    });

    expect(created.title).toBe("Design the Missions experience");
    expect(created.executor).toMatchObject({
      kind: "expert",
      ref: "expert:product_designer@0.1.0",
    });
    expect(created.project).toEqual({ id: "studio", revision: 3 });
    expect(created.toolPermissionMode).toBe("full-access");
    expect(created.modelOverride).toEqual({
      providerId: "provider",
      modelId: "configured-model",
      thinkingLevel: "high",
    });
    await expect(store.get(created.id)).resolves.toEqual(created);
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: created.id, title: created.title }),
    ]);
    const manifest = await readFile(join(root, "missions", created.id, "mission.yaml"), "utf8");
    expect(manifest).toContain("schemaVersion: pragma.mission/v3");
    expect(manifest).toContain("revision: 3");
    expect(manifest).toContain("toolPermissionMode: full-access");
    expect(manifest).toContain("modelOverride:");
    expect(manifest).not.toContain("messages:");
    expect(await readFile(join(root, "missions", created.id, "messages.jsonl"), "utf8")).toContain(
      '"kind":"user"',
    );
  });

  it("marks a mission complete and reopens it", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Review the desktop shell",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });

    const completed = await store.markComplete(created.id);
    expect(completed.lifecycleStatus).toBe("completed");
    expect(completed.completedAt).toBeDefined();

    const reopened = await store.reopen(created.id);
    expect(reopened.lifecycleStatus).toBe("active");
    expect(reopened.completedAt).toBeUndefined();
  });

  it("updates idle Mission options without changing pinned Mission identity", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Continue with a different model",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const execution = {
      id: "00000000-0000-4000-8000-000000000010",
      inputMessageId: created.initialMessageId,
      status: "running" as const,
      startedAt: "2026-07-15T00:00:00.000Z",
    };
    await store.updateExecution(created.id, execution);

    await expect(
      store.updateOptions(created.id, {
        toolPermissionMode: "full-access",
      }),
    ).rejects.toThrow("Wait for the current execution");

    await store.updateExecution(created.id, { ...execution, status: "succeeded" });
    const updated = await store.updateOptions(created.id, {
      toolPermissionMode: "auto-approve",
      modelOverride: { providerId: "provider", modelId: "next-model", thinkingLevel: "high" },
    });

    expect(updated.toolPermissionMode).toBe("auto-approve");
    expect(updated.modelOverride?.modelId).toBe("next-model");
    expect(updated.workspace).toEqual(created.workspace);
    expect(updated.executor).toEqual(created.executor);
    expect(updated.project).toEqual(created.project);

    const cleared = await store.updateOptions(created.id, {
      toolPermissionMode: "request-approval",
    });
    expect(cleared.modelOverride).toBeUndefined();
  });

  it("does not let a stale observer overwrite a terminal execution status", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Run once",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const executionId = "00000000-0000-4000-8000-000000000001";
    const startedAt = "2026-07-15T00:00:00.000Z";
    await store.updateExecution(created.id, {
      id: executionId,
      inputMessageId: created.initialMessageId,
      status: "running",
      startedAt,
    });
    await store.updateExecution(
      created.id,
      {
        id: executionId,
        inputMessageId: created.initialMessageId,
        status: "succeeded",
        startedAt,
        finishedAt: "2026-07-15T00:01:00.000Z",
      },
      { executionId, statuses: ["running", "waiting"] },
    );

    const stale = await store.updateExecution(
      created.id,
      {
        id: executionId,
        inputMessageId: created.initialMessageId,
        status: "waiting",
        startedAt,
      },
      { executionId, statuses: ["running", "waiting"] },
    );

    expect(stale.execution?.status).toBe("succeeded");
    expect((await store.get(created.id)).execution?.status).toBe("succeeded");
  });

  it("reports a stable error for a missing mission", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    await expect(store.get("00000000-0000-4000-8000-000000000000")).rejects.toMatchObject({
      code: "mission_not_found",
    });
  });

  it("deletes an idle mission and protects an active execution", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const idle = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Remove this conversation",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    await store.remove(idle.id);
    await expect(store.get(idle.id)).rejects.toMatchObject({ code: "mission_not_found" });

    const active = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Keep this execution",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    await store.updateExecution(active.id, {
      id: "00000000-0000-4000-8000-000000000002",
      inputMessageId: active.initialMessageId,
      status: "running",
      startedAt: "2026-07-16T00:00:00.000Z",
    });
    await expect(store.remove(active.id)).rejects.toMatchObject({ code: "mission_active" });
  });

  it("appends idempotent timeline records and pages logical turns", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Initial request",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const message = {
      id: "00000000-0000-4000-8000-000000000010",
      content: "Follow up",
      createdAt: "2026-07-17T00:00:00.000Z",
    };
    const first = await store.appendUserMessage(created.id, message);
    const duplicate = await store.appendUserMessage(created.id, message);
    expect(duplicate).toEqual(first);
    const executionReference = {
      missionId: created.id,
      inputMessageId: message.id,
      executionId: "00000000-0000-4000-8000-000000000011",
      createdAt: "2026-07-17T00:00:01.000Z",
    };
    const firstExecutionReference = await store.appendExecutionReference(executionReference);
    await expect(store.appendExecutionReference(executionReference)).resolves.toEqual(
      firstExecutionReference,
    );

    const latest = await store.readTimelinePage(created.id, { limit: 1 });
    expect(latest.turns).toEqual([
      expect.objectContaining({
        sequence: 2,
        message: expect.objectContaining({ content: "Follow up" }),
        executionId: "00000000-0000-4000-8000-000000000011",
      }),
    ]);
    expect(latest.nextBeforeSequence).toBe(2);
    await expect(
      store.readTimelinePage(created.id, { beforeSequence: 2, limit: 1 }),
    ).resolves.toMatchObject({
      turns: [expect.objectContaining({ sequence: 1 })],
    });
    await expect(
      store.appendUserMessage(created.id, { ...message, content: "Conflicting content" }),
    ).rejects.toMatchObject({ code: "message_conflict" });
  });

  it("recovers a journaled append and repairs only a torn final line", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Recover timeline",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const directory = join(root, "missions", created.id);
    await appendFile(join(directory, "messages.jsonl"), '{"torn"', "utf8");
    await writeFile(
      join(directory, ".messages.transaction.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.mission-message-transaction/v1",
        record: {
          schemaVersion: "pragma.mission-message/v1",
          sequence: 2,
          kind: "execution",
          inputMessageId: created.initialMessageId,
          executionId: "00000000-0000-4000-8000-000000000012",
          createdAt: "2026-07-17T00:00:01.000Z",
        },
        updatedAt: "2026-07-17T00:00:02.000Z",
      })}\n`,
      "utf8",
    );

    await store.get(created.id);
    const timeline = await store.readTimelinePage(created.id, { limit: 10 });
    expect(timeline.turns[0]?.executionId).toBe("00000000-0000-4000-8000-000000000012");
    expect(await readFile(join(directory, "messages.jsonl"), "utf8")).not.toContain("torn");
  });

  it("rejects v2 explicitly and does not read timelines while listing summaries", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Versioned storage",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const directory = join(root, "missions", created.id);
    await appendFile(join(directory, "messages.jsonl"), "invalid-json\n", "utf8");
    await expect(store.list()).resolves.toEqual([expect.objectContaining({ id: created.id })]);
    await expect(store.readTimelinePage(created.id, { limit: 50 })).rejects.toMatchObject({
      code: "timeline_invalid",
    });

    const manifestPath = join(directory, "mission.yaml");
    await writeFile(
      manifestPath,
      (await readFile(manifestPath, "utf8")).replace("pragma.mission/v3", "pragma.mission/v2"),
      "utf8",
    );
    await expect(store.get(created.id)).rejects.toMatchObject({ code: "unsupported_schema" });
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pragma-missions-"));
  temporaryPaths.push(path);
  return path;
}

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: "pragma/v2",
    kind: "Expert",
    metadata: {
      id: "product_designer",
      name: "Product Designer",
      description: "Designs product experiences.",
      tags: ["design"],
      version: "0.1.0",
    },
    spec: {
      scope: "Product experience design.",
      instructions: "Design accessible product experiences.",
      runtime: { ref: "runtime-profile:product_designer_runtime@0.1.0" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}
