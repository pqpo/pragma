import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { appendFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import type { PragmaExpertResource } from "@pragma/interpreter/ast";
import { missionExecutorSnapshot } from "../../../shared/contracts/index.ts";
import {
  MISSION_EXECUTION_PROJECTION_MAX_BYTES,
  MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH,
  MISSION_EXECUTION_PROJECTION_MAX_ENTRIES,
} from "./mission-execution-projection.ts";
import { createMissionStore, MISSION_TITLE_MAX_LENGTH } from "./mission-store.ts";

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
      ref: "expert:v2vt1v01vzz6j24q",
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
    expect(manifest).toContain("schemaVersion: pragma.mission/v8");
    expect(created.contextStoreIds).toEqual([]);
    expect(manifest).toContain("revision: 3");
    expect(manifest).toContain("toolPermissionMode: full-access");
    expect(manifest).toContain("modelOverride:");
    expect(manifest).not.toContain("messages:");
    expect(await readFile(join(root, "missions", created.id, "messages.jsonl"), "utf8")).toContain(
      '"kind":"user"',
    );
    await expect(store.getAttachments(created.id)).resolves.toEqual([]);
  });

  it("tracks Knowledge Store references without owning the Store lifecycle", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const contextStoreId = "10000000-0000-4000-8000-000000000001";
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Use Mission Knowledge",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
      contextStoreIds: [contextStoreId],
    });

    await expect(store.isContextStoreReferenced(contextStoreId)).resolves.toBe(true);
    await expect(store.updateContextStores(created.id, [])).resolves.toMatchObject({
      contextStoreIds: [],
    });
    await expect(store.isContextStoreReferenced(contextStoreId)).resolves.toBe(false);
  });

  it("materializes images inside the Mission while keeping file and directory references", async () => {
    const root = await temporaryRoot();
    const sourceDir = join(root, "source");
    const folder = join(sourceDir, "fixtures");
    const image = join(sourceDir, "screen.png");
    const optimizedImage = join(sourceDir, "screen.optimized.webp");
    const file = join(sourceDir, "requirements.md");
    await mkdir(folder, { recursive: true });
    await writeFile(image, "image-bytes");
    await writeFile(optimizedImage, "optimized-image-bytes");
    await writeFile(file, "requirements");
    const store = createMissionStore({ missionsPath: join(root, "missions") });

    const mission = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Review the attached context",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          kind: "image",
          name: "screen.png",
          path: image,
          mimeType: "image/png",
          optimized: {
            path: optimizedImage,
            mimeType: "image/webp",
            size: 21,
          },
        },
        {
          id: "00000000-0000-4000-8000-000000000002",
          kind: "file",
          name: "requirements.md",
          path: file,
        },
        {
          id: "00000000-0000-4000-8000-000000000003",
          kind: "directory",
          name: "fixtures",
          path: folder,
        },
      ],
    });

    const stored = await store.getAttachments(mission.id);
    expect(stored).toHaveLength(3);
    expect(stored[0]).toMatchObject({ kind: "image", mimeType: "image/png" });
    expect(stored[0]?.path).toBe(
      join(root, "missions", mission.id, "attachments", "images", `${stored[0]?.id}.png`),
    );
    await expect(readFile(stored[0]!.path, "utf8")).resolves.toBe("image-bytes");
    expect(stored[0]?.optimized?.path).toBe(
      join(
        root,
        "missions",
        mission.id,
        "attachments",
        "images",
        "optimized",
        `${stored[0]?.id}.webp`,
      ),
    );
    await expect(readFile(stored[0]!.optimized!.path, "utf8")).resolves.toBe(
      "optimized-image-bytes",
    );
    expect(stored[1]).toMatchObject({ kind: "file", path: await realpath(file), size: 12 });
    expect(stored[2]).toEqual({
      id: "00000000-0000-4000-8000-000000000003",
      kind: "directory",
      name: "fixtures",
      path: await realpath(folder),
    });
    expect(
      JSON.parse(await readFile(join(root, "missions", mission.id, "attachments.json"), "utf8")),
    ).toMatchObject({ schemaVersion: "pragma.mission-attachments/v1" });
    const initialTurn = (await store.readTimelinePage(mission.id, { limit: 10 })).turns[0];
    expect(initialTurn?.message.attachments).toEqual(stored);
  });

  it("materializes follow-up attachments on their own timeline message", async () => {
    const root = await temporaryRoot();
    const firstImage = join(root, "first.png");
    const followupImage = join(root, "followup.png");
    await writeFile(firstImage, "first-image");
    await writeFile(followupImage, "followup-image");
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Review the first image",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000001",
          kind: "image",
          name: "first.png",
          path: firstImage,
          mimeType: "image/png",
        },
      ],
    });

    const record = await store.appendUserMessage(mission.id, {
      id: "00000000-0000-4000-8000-000000000003",
      content: "Now review this image.",
      attachments: [
        {
          id: "00000000-0000-4000-8000-000000000002",
          kind: "image",
          name: "pasted-image.png",
          path: followupImage,
          mimeType: "image/png",
        },
      ],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(record.kind).toBe("user");
    const added = record.kind === "user" ? (record.attachments ?? []) : [];

    const turns = (await store.readTimelinePage(mission.id, { limit: 10 })).turns;
    expect(turns[0]?.message.attachments?.map(({ name }) => name)).toEqual(["first.png"]);
    expect(turns[1]?.message.attachments?.map(({ name }) => name)).toEqual(["pasted-image.png"]);
    await expect(readFile(added[0]!.path, "utf8")).resolves.toBe("followup-image");
    await expect(store.getAttachments(mission.id)).resolves.toHaveLength(2);
  });

  it("recovers a follow-up whose attachment manifest persisted before its user message", async () => {
    const root = await temporaryRoot();
    const source = join(root, "followup.png");
    await writeFile(source, "followup-image");
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Review an image",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const missionDirectory = join(root, "missions", mission.id);
    const messageId = "00000000-0000-4000-8000-000000000003";
    const attachmentId = "00000000-0000-4000-8000-000000000002";
    const storedPath = join(missionDirectory, "attachments", "images", `${attachmentId}.png`);
    await mkdir(join(missionDirectory, "attachments", "images"), { recursive: true });
    await writeFile(storedPath, "followup-image");
    const storedAttachment = {
      id: attachmentId,
      kind: "image" as const,
      name: "followup.png",
      path: storedPath,
      mimeType: "image/png" as const,
      size: 14,
    };
    const baseAttachments = {
      schemaVersion: "pragma.mission-attachments/v1" as const,
      attachments: [],
    };
    const targetAttachments = {
      schemaVersion: "pragma.mission-attachments/v1" as const,
      attachments: [storedAttachment],
    };
    await writeFile(
      join(missionDirectory, "attachments.json"),
      `${JSON.stringify(targetAttachments, null, 2)}\n`,
    );
    await writeFile(
      join(missionDirectory, ".user-message-attachments.transaction.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.mission-user-message-attachments-transaction/v1",
        baseAttachments,
        targetAttachments,
        record: {
          schemaVersion: "pragma.mission-message/v1",
          sequence: 2,
          kind: "user",
          id: messageId,
          content: "Now review this image.",
          attachments: [storedAttachment],
          createdAt: "2026-08-10T00:00:00.000Z",
        },
        updatedAt: "2026-08-10T00:00:01.000Z",
      })}\n`,
    );

    const recovered = await store.readTimelinePage(mission.id, { limit: 10 });

    expect(recovered.turns[1]?.message).toMatchObject({
      id: messageId,
      attachments: [expect.objectContaining({ id: attachmentId, path: storedPath })],
    });
    await expect(store.getAttachments(mission.id)).resolves.toEqual([storedAttachment]);
    await expect(
      readFile(join(missionDirectory, ".user-message-attachments.transaction.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const duplicate = await store.appendUserMessage(mission.id, {
      id: messageId,
      content: "Now review this image.",
      attachments: [
        {
          id: attachmentId,
          kind: "image",
          name: "followup.png",
          path: source,
          mimeType: "image/png",
        },
      ],
      createdAt: "2026-08-10T00:00:00.000Z",
    });
    expect(duplicate).toMatchObject({
      schemaVersion: "pragma.mission-message/v1",
      sequence: 2,
      kind: "user",
      id: messageId,
      attachments: [expect.objectContaining({ id: attachmentId })],
    });
    await expect(store.readTimelinePage(mission.id, { limit: 10 })).resolves.toMatchObject({
      turns: [{}, {}],
    });
  });

  it("fails closed when the attachment manifest is corrupted", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Review the attached context",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    await writeFile(join(root, "missions", mission.id, "attachments.json"), "{not-json");

    await expect(store.getAttachments(mission.id)).rejects.toMatchObject({
      code: "config_invalid",
    });
  });

  it("resolves legacy execution-scoped jobs to their Mission titles", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const mission = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Prepare the release notes",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const executionId = "18e8cabd-dab7-4256-be4c-731ad50339b1";
    await store.appendExecutionReference({
      missionId: mission.id,
      inputMessageId: mission.initialMessageId,
      executionId,
      createdAt: "2026-08-05T08:00:00.000Z",
    });

    const titles = await store.resolveExecutionTitles([executionId, crypto.randomUUID()]);
    expect(titles.get(executionId)).toBe("Prepare the release notes");
    expect(titles.size).toBe(1);

    await store.remove(mission.id);
    expect(await store.resolveExecutionTitles([executionId])).toEqual(new Map());
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

  it("lists user and Automation Missions while keeping system Memory Missions internal", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const user = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Visible Mission",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const internal = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Internal extraction",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
      origin: { type: "system-memory", jobId: "memory-job" },
    });
    const automation = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Scheduled review",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
      origin: { type: "automation", automationRef: "automation:m9a8n9nxvvyb4j01" },
    });

    await expect(store.list()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: automation.id,
          source: { type: "automation", automationRef: "automation:m9a8n9nxvvyb4j01" },
        }),
        expect.objectContaining({ id: user.id, source: { type: "task" } }),
      ]),
    );
    await expect(store.get(internal.id)).resolves.toMatchObject({
      origin: { type: "system-memory" },
    });
  });

  it("persists a recoverable legacy Automation origin without changing Mission recency", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const legacy = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Legacy scheduled review",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });

    const migrated = await store.backfillAutomationOrigin(legacy.id, "automation:m9a8n9nxvvyb4j01");

    expect(migrated).toMatchObject({
      id: legacy.id,
      origin: { type: "automation", automationRef: "automation:m9a8n9nxvvyb4j01" },
      updatedAt: legacy.updatedAt,
    });
    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({
        id: legacy.id,
        source: { type: "automation", automationRef: "automation:m9a8n9nxvvyb4j01" },
        updatedAt: legacy.updatedAt,
      }),
    ]);
  });

  it("limits rule-based titles derived from the Mission goal", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "为每一个 Git 子模块创建并推送 feature/pnpm-workspace-compat 分支，同时检查远程状态",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });

    expect(Array.from(created.title)).toHaveLength(MISSION_TITLE_MAX_LENGTH);
    expect(created.title.endsWith("…")).toBe(true);
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

  it("stores bounded Execution projections as recoverable JSONL", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Keep bounded history",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const executionId = "00000000-0000-4000-8000-000000000020";
    const entries = Array.from(
      { length: MISSION_EXECUTION_PROJECTION_MAX_ENTRIES + 2 },
      (_, index) => ({
        id: `assistant:${index}`,
        executionId,
        kind: "assistant" as const,
        content:
          index === MISSION_EXECUTION_PROJECTION_MAX_ENTRIES + 1
            ? "x".repeat(MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH + 10)
            : `answer ${index}`,
        streaming: false,
        createdAt: "2026-07-17T00:00:01.000Z",
      }),
    );

    await store.writeExecutionProjection(created.id, executionId, entries);

    const projectionPath = join(
      root,
      "missions",
      created.id,
      "execution-projections",
      `${executionId}.jsonl`,
    );
    const content = await readFile(projectionPath, "utf8");
    const lines = content.trimEnd().split("\n");
    const header = JSON.parse(lines[0]!) as {
      omittedEntries: number;
      truncatedFields: number;
    };
    const lastRecord = JSON.parse(lines.at(-1)!) as {
      truncation?: { truncated: boolean; fields: Array<{ originalLength: number }> };
    };
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MISSION_EXECUTION_PROJECTION_MAX_BYTES);
    expect(lines).toHaveLength(MISSION_EXECUTION_PROJECTION_MAX_ENTRIES + 1);
    expect(header).toMatchObject({ omittedEntries: 2, truncatedFields: 1 });
    expect(lastRecord.truncation).toMatchObject({
      truncated: true,
      fields: [{ originalLength: MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH + 10 }],
    });

    const projected = await store.readExecutionProjection(created.id, executionId);
    expect(projected).toHaveLength(MISSION_EXECUTION_PROJECTION_MAX_ENTRIES);
    expect(projected?.[0]?.id).toBe("assistant:2");
    expect(projected?.at(-1)).toMatchObject({
      id: `assistant:${MISSION_EXECUTION_PROJECTION_MAX_ENTRIES + 1}`,
      content: "x".repeat(MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH),
    });

    await appendFile(projectionPath, '{"torn"', "utf8");
    await expect(store.readExecutionProjection(created.id, executionId)).resolves.toHaveLength(
      MISSION_EXECUTION_PROJECTION_MAX_ENTRIES,
    );
    await appendFile(projectionPath, "\n", "utf8");
    await expect(store.readExecutionProjection(created.id, executionId)).rejects.toMatchObject({
      code: "projection_invalid",
    });

    await store.writeExecutionProjection(created.id, executionId, entries);
    await appendFile(
      projectionPath,
      JSON.stringify({ ...lastRecord, executionId: "another-execution" }),
      "utf8",
    );
    await expect(store.readExecutionProjection(created.id, executionId)).rejects.toMatchObject({
      code: "projection_invalid",
    });
  });

  it("caps a projection by encoded byte size and retains the newest output", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Keep the newest bounded output",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const executionId = "00000000-0000-4000-8000-000000000022";
    const entryCount = 140;
    const entries = Array.from({ length: entryCount }, (_, index) => ({
      id: `large-assistant:${index}`,
      executionId,
      kind: "assistant" as const,
      content: `${index}:`.padEnd(MISSION_EXECUTION_PROJECTION_MAX_CONTENT_LENGTH, "x"),
      streaming: false,
      createdAt: "2026-07-17T00:00:01.000Z",
    }));

    await store.writeExecutionProjection(created.id, executionId, entries);

    const projectionPath = join(
      root,
      "missions",
      created.id,
      "execution-projections",
      `${executionId}.jsonl`,
    );
    const content = await readFile(projectionPath, "utf8");
    const header = JSON.parse(content.split("\n", 1)[0]!) as { omittedEntries: number };
    const projected = await store.readExecutionProjection(created.id, executionId);
    expect(Buffer.byteLength(content)).toBeLessThanOrEqual(MISSION_EXECUTION_PROJECTION_MAX_BYTES);
    expect(header.omittedEntries).toBeGreaterThan(0);
    expect(projected?.length).toBeLessThan(entryCount);
    expect(projected?.at(-1)?.id).toBe(`large-assistant:${entryCount - 1}`);
  });

  it("migrates legacy JSON projections on first read and removes them with the Mission", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Migrate visible history",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const executionId = "00000000-0000-4000-8000-000000000021";
    const directory = join(root, "missions", created.id, "execution-projections");
    const legacyPath = join(directory, `${executionId}.json`);
    const currentPath = join(directory, `${executionId}.jsonl`);
    const entry = {
      id: "assistant:legacy",
      executionId,
      kind: "assistant" as const,
      content: "Legacy answer",
      streaming: false,
      createdAt: "2026-07-17T00:00:01.000Z",
    };
    await mkdir(directory, { recursive: true });
    await writeFile(
      legacyPath,
      `${JSON.stringify({
        schemaVersion: "pragma.mission-execution-projection/v1",
        executionId,
        entries: [entry],
        createdAt: "2026-07-17T00:00:02.000Z",
      })}\n`,
      "utf8",
    );

    await expect(store.readExecutionProjection(created.id, executionId)).resolves.toEqual([entry]);
    await expect(readFile(legacyPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(currentPath, "utf8")).toContain(
      '"schemaVersion":"pragma.mission-execution-projection/v2"',
    );

    await store.remove(created.id);
    await expect(readFile(currentPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
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
      (await readFile(manifestPath, "utf8")).replace("pragma.mission/v8", "pragma.mission/v2"),
      "utf8",
    );
    await expect(store.get(created.id)).rejects.toMatchObject({ code: "unsupported_schema" });
  });

  it("keeps readable Missions visible when another Mission uses an unsupported schema", async () => {
    const root = await temporaryRoot();
    const issues: Array<{ readonly missionId: string; readonly error: { readonly code: string } }> =
      [];
    const store = createMissionStore({
      missionsPath: join(root, "missions"),
      onReadIssue: (issue) => issues.push(issue),
    });
    const readable = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Readable Mission",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const unsupported = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Future Mission",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const unsupportedManifest = join(root, "missions", unsupported.id, "mission.yaml");
    await writeFile(
      unsupportedManifest,
      (await readFile(unsupportedManifest, "utf8")).replace(
        "pragma.mission/v8",
        "pragma.mission/v99",
      ),
      "utf8",
    );

    await expect(store.list()).resolves.toEqual([
      expect.objectContaining({ id: readable.id, title: readable.title }),
    ]);
    expect(issues).toEqual([
      expect.objectContaining({
        missionId: unsupported.id,
        error: expect.objectContaining({ code: "unsupported_schema" }),
      }),
    ]);
    await expect(readFile(unsupportedManifest, "utf8")).resolves.toContain(
      "schemaVersion: pragma.mission/v99",
    );
  });

  it("reports an error instead of presenting an empty list when no user Mission is readable", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Readable internal Mission",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
      origin: { type: "system-memory", jobId: "memory-job" },
    });
    const unsupported = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Only future Mission",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const unsupportedManifest = join(root, "missions", unsupported.id, "mission.yaml");
    await writeFile(
      unsupportedManifest,
      (await readFile(unsupportedManifest, "utf8")).replace(
        "pragma.mission/v8",
        "pragma.mission/v99",
      ),
      "utf8",
    );

    await expect(store.list()).rejects.toMatchObject({ code: "unsupported_schema" });
    await expect(readFile(unsupportedManifest, "utf8")).resolves.toContain(
      "schemaVersion: pragma.mission/v99",
    );
  });

  it("migrates v3 Flow input atomically and rejects future Mission schemas", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const workspace = join(root, "workspace");
    const created = await store.create({
      workspace: { path: workspace, basename: "workspace" },
      goal: "Legacy Flow goal",
      flowInput: { goal: "Legacy Flow goal", workspace },
      project: { id: "studio", revision: 1 },
      executor: {
        kind: "flow",
        ref: "flow:x22wv3j4gn3k9j5v",
        name: "Legacy Flow",
      },
    });
    const manifestPath = join(root, "missions", created.id, "mission.yaml");
    const legacy = parsePragmaYaml(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    legacy["schemaVersion"] = "pragma.mission/v3";
    legacy["executor"] = { ...(legacy["executor"] as object), version: "1.0.0" };
    delete legacy["flowInput"];
    await writeFile(manifestPath, formatPragmaYaml(legacy), "utf8");

    await expect(store.get(created.id)).resolves.toMatchObject({
      schemaVersion: "pragma.mission/v8",
      flowInput: { goal: "Legacy Flow goal", workspace },
    });
    expect(await readFile(manifestPath, "utf8")).toContain("schemaVersion: pragma.mission/v8");

    const future = parsePragmaYaml(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    future["schemaVersion"] = "pragma.mission/v99";
    await writeFile(manifestPath, formatPragmaYaml(future), "utf8");
    await expect(store.get(created.id)).rejects.toMatchObject({ code: "unsupported_schema" });
  });

  it("migrates v5 Missions to an explicit user origin", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Migrate Mission ownership",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const manifestPath = join(root, "missions", created.id, "mission.yaml");
    const legacy = parsePragmaYaml(await readFile(manifestPath, "utf8")) as Record<string, unknown>;
    legacy["schemaVersion"] = "pragma.mission/v5";
    delete legacy["origin"];
    await writeFile(manifestPath, formatPragmaYaml(legacy), "utf8");

    await expect(store.get(created.id)).resolves.toMatchObject({
      schemaVersion: "pragma.mission/v8",
      origin: { type: "user" },
    });
    expect(await readFile(manifestPath, "utf8")).toContain("type: user");
    expect(
      await readFile(
        join(root, "missions", created.id, "migration-backups", "mission.v6.yaml"),
        "utf8",
      ),
    ).toContain("schemaVersion: pragma.mission/v6");
  });

  it("migrates v7 Missions to empty Mission Knowledge references with a backup", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const { directory, id, source } = await installMissionV7Fixture(root);

    await expect(store.get(id)).resolves.toMatchObject({
      schemaVersion: "pragma.mission/v8",
      contextStoreIds: [],
    });
    expect(
      parsePragmaYaml(
        await readFile(join(directory, "migration-backups", "mission.v7.yaml"), "utf8"),
      ),
    ).toEqual(parsePragmaYaml(source));
  });

  it("replays an interrupted v7-to-v8 migration journal", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const { directory, id, source } = await installMissionV7Fixture(root);
    const target = {
      ...(parsePragmaYaml(source) as Record<string, unknown>),
      schemaVersion: "pragma.mission/v8",
      contextStoreIds: [],
    };
    await writeFile(
      join(directory, ".v7-to-v8.transaction.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.mission-v8-migration/v1",
        missionId: id,
        target,
      })}\n`,
      "utf8",
    );

    await expect(store.get(id)).resolves.toMatchObject({
      schemaVersion: "pragma.mission/v8",
      contextStoreIds: [],
    });
    await expect(
      readFile(join(directory, ".v7-to-v8.transaction.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves v6 when the adjacent v7 target fails historical validation", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const { directory, id, source } = await installMissionV7Fixture(root);
    const malformedV6 = {
      ...(parsePragmaYaml(source) as Record<string, unknown>),
      schemaVersion: "pragma.mission/v6",
      executor: {
        kind: "flow",
        ref: "flow:v2vt1v01vzz6j24q",
        name: "Broken historical Flow",
      },
    };
    await writeFile(join(directory, "mission.yaml"), formatPragmaYaml(malformedV6), "utf8");

    await expect(store.get(id)).rejects.toMatchObject({ code: "config_invalid" });
    expect(
      (
        parsePragmaYaml(await readFile(join(directory, "mission.yaml"), "utf8")) as {
          schemaVersion: string;
        }
      ).schemaVersion,
    ).toBe("pragma.mission/v6");
    await expect(
      readFile(join(directory, ".v6-to-v7.transaction.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("replays an interrupted v6-to-v7 migration journal", async () => {
    const root = await temporaryRoot();
    const store = createMissionStore({ missionsPath: join(root, "missions") });
    const created = await store.create({
      workspace: { path: join(root, "workspace"), basename: "workspace" },
      goal: "Recover Mission migration",
      project: { id: "studio", revision: 1 },
      executor: missionExecutorSnapshot(expertFixture()),
    });
    const directory = join(root, "missions", created.id);
    const manifestPath = join(directory, "mission.yaml");
    const current = parsePragmaYaml(await readFile(manifestPath, "utf8")) as Record<
      string,
      unknown
    >;
    const legacy = {
      ...current,
      schemaVersion: "pragma.mission/v6",
    };
    const target = { ...legacy, schemaVersion: "pragma.mission/v7" };
    await writeFile(manifestPath, formatPragmaYaml(legacy), "utf8");
    await writeFile(
      join(directory, ".v6-to-v7.transaction.json"),
      `${JSON.stringify({
        schemaVersion: "pragma.mission-v7-migration/v1",
        missionId: created.id,
        target,
      })}\n`,
      "utf8",
    );

    await expect(store.get(created.id)).resolves.toMatchObject({
      schemaVersion: "pragma.mission/v8",
      id: created.id,
    });
    await expect(
      readFile(join(directory, ".v6-to-v7.transaction.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function temporaryRoot(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "pragma-missions-"));
  temporaryPaths.push(path);
  return path;
}

function expertFixture(): PragmaExpertResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Expert",
    metadata: {
      id: "v2vt1v01vzz6j24q",
      avatarId: "pragma.avatar.expert.default",
      name: "Product Designer",
      description: "Designs product experiences.",
      tags: ["design"],
    },
    spec: {
      scope: "Product experience design.",
      instructions: "Design accessible product experiences.",
      runtime: { ref: "runtime-profile:9a20pvstre59317h" },
      capabilities: [],
      toolApprovals: {},
      contextStores: [],
      plugins: [],
      tools: [],
    },
  };
}

async function installMissionV7Fixture(root: string): Promise<{
  readonly directory: string;
  readonly id: string;
  readonly source: string;
}> {
  const source = await readFile(new URL("./fixtures/mission-v7.yaml", import.meta.url), "utf8");
  const manifest = parsePragmaYaml(source) as { readonly id: string };
  const directory = join(root, "missions", manifest.id);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "mission.yaml"), source, "utf8");
  return { directory, id: manifest.id, source };
}
