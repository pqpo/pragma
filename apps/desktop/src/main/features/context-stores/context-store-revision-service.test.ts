import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createContextStoreRevisionService } from "./context-store-revision-service.ts";
import { createContextStoreStore } from "./context-store-store.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true })));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "pragma-store-revisions-"));
  directories.push(directory);
  const contextStores = createContextStoreStore({
    storesPath: join(directory, "data", "context-stores"),
  });
  const service = createContextStoreRevisionService({
    statePath: join(directory, "state", "context-store-revisions"),
    contextStores,
    generator: {
      async generate({ request, snapshot }) {
        return {
          schemaVersion: "pragma.context-store-change-set/v1" as const,
          storeId: request.storeId,
          baseRevision: snapshot.revision,
          baseSnapshotHash: snapshot.snapshotHash,
          summary: request.prompt,
          operations: [
            {
              operation: "upsert" as const,
              id: "items/revised.md",
              content: `# ${request.prompt}\n`,
              metadata: {
                description: "Revised guidance",
                trigger: "manual" as const,
                priority: "normal" as const,
              },
            },
          ],
        };
      },
    },
  });
  const store = await contextStores.create({ mode: "blank", name: "Knowledge", description: "" });
  return { directory, contextStores, service, store };
}

describe("context store revision service", () => {
  it("deduplicates reflection retries by execution provenance digest", async () => {
    const { service, store } = await fixture();
    const request = {
      schemaVersion: "pragma.context-store-revision-request/v1" as const,
      storeId: store.id,
      prompt: "Record the reflected invariant",
      source: "expert-reflection" as const,
      sourceDigest: "b".repeat(64),
      provenance: {
        executionId: "execution-1",
        invocationId: "invocation-1",
        expertId: "0000000000000002",
        teamId: "0000000000000003",
      },
    };

    const first = await service.submit(request);
    const retry = await service.submit(request);

    expect(retry.id).toBe(first.id);
    await expect(service.list()).resolves.toHaveLength(1);
  });

  it("stages an agent changeset for review and only writes after approval", async () => {
    const { contextStores, service, store } = await fixture();
    const submitted = await service.submit({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Add retry guidance",
      source: "user",
    });

    await service.processPending();
    const staged = await service.get(submitted.id);
    expect(staged).toMatchObject({ state: "pending_review", revision: 3 });
    await expect(contextStores.listEntries(store.id)).resolves.toEqual([]);

    const completed = await service.approve(staged.id, staged.revision);
    expect(completed.state).toBe("completed");
    await expect(contextStores.getContent(store.id, "items/revised.md")).resolves.toMatchObject({
      content: "# Add retry guidance\n",
    });
    await expect(contextStores.history(store.id)).resolves.toEqual([
      expect.objectContaining({ revision: 2, author: "store-revision-agent" }),
      expect.objectContaining({ revision: 1, author: "user" }),
    ]);
  });

  it("preserves base file content for revision diff review", async () => {
    const { contextStores, service, store } = await fixture();
    await contextStores.createFile(store.id, "items/revised.md", "# Previous guidance\n");
    const submitted = await service.submit({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Update guidance",
      source: "user",
    });

    await service.processPending();

    await expect(service.get(submitted.id)).resolves.toMatchObject({
      state: "pending_review",
      changeSet: {
        operations: [
          {
            operation: "upsert",
            id: "items/revised.md",
            previousContent: "# Previous guidance\n",
            content: "# Update guidance\n",
          },
        ],
      },
    });
  });

  it("supersedes stale approval and automatically requeues the original prompt", async () => {
    const { contextStores, service, store } = await fixture();
    const submitted = await service.submit({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Preserve this prompt",
      source: "memory-learning",
      sourceDigest: "a".repeat(64),
    });
    await service.processPending();
    const staged = await service.get(submitted.id);
    await contextStores.createFile(store.id, "user-note.md", "# User note\n");

    const superseded = await service.approve(staged.id, staged.revision);
    expect(superseded).toMatchObject({ state: "superseded", supersededBy: expect.any(String) });
    const replacement = await service.get(superseded.supersededBy!);
    expect(replacement).toMatchObject({
      state: "pending",
      request: expect.objectContaining({
        prompt: "Preserve this prompt",
        sourceDigest: "a".repeat(64),
      }),
    });
    await expect(contextStores.getContent(store.id, "items/revised.md")).rejects.toMatchObject({
      code: "content_not_found",
    });
  });

  it("replays an applying task after a process crash", async () => {
    const { directory, contextStores, service, store } = await fixture();
    const submitted = await service.submit({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Recover this apply",
      source: "user",
    });
    await service.processPending();
    const staged = await service.get(submitted.id);
    await writeFile(
      join(directory, "state", "context-store-revisions", "jobs", `${staged.id}.json`),
      `${JSON.stringify({
        ...staged,
        revision: staged.revision + 1,
        state: "applying",
      })}\n`,
      "utf8",
    );

    await service.processPending();

    await expect(service.get(staged.id)).resolves.toMatchObject({ state: "completed" });
    await expect(contextStores.history(store.id)).resolves.toEqual([
      expect.objectContaining({
        revision: 2,
        author: "store-revision-agent",
        revisionJobId: staged.id,
      }),
      expect.objectContaining({ revision: 1 }),
    ]);
  });

  it("requeues a running task left behind by a process crash", async () => {
    const { directory, service, store } = await fixture();
    const submitted = await service.submit({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Recover generation",
      source: "user",
    });
    await writeFile(
      join(directory, "state", "context-store-revisions", "jobs", `${submitted.id}.json`),
      `${JSON.stringify({ ...submitted, revision: 2, state: "running" })}\n`,
      "utf8",
    );

    await service.processPending();

    await expect(service.get(submitted.id)).resolves.toMatchObject({
      state: "pending_review",
      revision: 5,
    });
  });

  it("deduplicates replayed Memory revision submissions", async () => {
    const { service, store } = await fixture();
    const request = {
      schemaVersion: "pragma.context-store-revision-request/v1" as const,
      storeId: store.id,
      prompt: "Merge learned guidance",
      source: "memory-learning" as const,
      sourceDigest: "b".repeat(64),
    };

    const first = await service.submit(request);
    const replay = await service.submit(request);

    expect(replay.id).toBe(first.id);
    await expect(service.list()).resolves.toHaveLength(1);
  });

  it("rejects a changeset that breaks a progressive knowledge Store", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-progressive-revision-"));
    directories.push(directory);
    const contextStores = createContextStoreStore({ storesPath: join(directory, "stores") });
    const metadata = (trigger: "always_on" | "model_decision" | "manual") => ({
      description: "Knowledge",
      trigger,
      priority: "normal" as const,
    });
    const store = await contextStores.createFromSnapshot({
      name: "Memory",
      description: "",
      author: "memory-initialization",
      summary: "Initialize",
      files: [
        { id: "guide.md", content: "# Guide\n", metadata: metadata("always_on") },
        { id: "overview.md", content: "# Overview\n", metadata: metadata("model_decision") },
        { id: "index.md", content: "# Index\n", metadata: metadata("model_decision") },
        { id: "items/detail.md", content: "# Detail\n", metadata: metadata("manual") },
      ],
    });
    const service = createContextStoreRevisionService({
      statePath: join(directory, "revisions"),
      contextStores,
      generator: {
        async generate({ snapshot }) {
          return {
            schemaVersion: "pragma.context-store-change-set/v1",
            storeId: store.id,
            baseRevision: snapshot.revision,
            baseSnapshotHash: snapshot.snapshotHash,
            summary: "Break structure",
            operations: [{ operation: "delete", id: "guide.md" }],
          };
        },
      },
    });
    const submitted = await service.submit({
      schemaVersion: "pragma.context-store-revision-request/v1",
      storeId: store.id,
      prompt: "Remove the guide",
      source: "user",
    });

    await service.processPending();

    await expect(service.get(submitted.id)).resolves.toMatchObject({
      state: "needs_attention",
      error: { code: "generation_failed" },
    });
    await expect(contextStores.getContent(store.id, "guide.md")).resolves.toBeDefined();
  });
});
