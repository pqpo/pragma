import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createMemoryExtractionRunArchive } from "./memory-extraction-run-archive.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Memory extraction run archive", () => {
  it("persists a bounded read-only transcript independently from the temporary Mission", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-run-archive-"));
    roots.push(root);
    const archive = createMemoryExtractionRunArchive(root);
    const runId = "d5f1da5e-9201-49e8-9018-16779707ed1c";
    const missionId = "39ed3fdf-0f0a-437e-8cd8-d059a96761e8";
    await archive.save({
      schemaVersion: "pragma.desktop-memory-extraction-run/v1",
      runId,
      missionId,
      module: "skill",
      jobId: "skill-job",
      status: "failed",
      startedAt: "2026-08-05T08:00:00.000Z",
      finishedAt: "2026-08-05T08:00:30.000Z",
      runtimeId: "runtime-a",
      providerId: "provider-a",
      modelId: "model-a",
      failure: {
        schemaVersion: "pragma.memory-extraction-failure/v1",
        code: "rate_limit_exceeded",
        message: "429 rate limit exceeded",
        phase: "curator_run",
        failedAt: "2026-08-05T08:00:30.000Z",
        transport: { httpStatus: 429 },
      },
      chat: {
        missionId,
        revision: 1,
        entries: [
          {
            id: "assistant-1",
            kind: "assistant",
            content: "The provider returned a rate limit response.",
            streaming: false,
            createdAt: "2026-08-05T08:00:30.000Z",
          },
        ],
        page: { oldestSequence: 1, newestSequence: 1 },
        pendingInteractions: [],
      },
    });

    await expect(archive.get(runId)).resolves.toMatchObject({
      status: "failed",
      failure: { code: "rate_limit_exceeded", transport: { httpStatus: 429 } },
      chat: { entries: [{ content: "The provider returned a rate limit response." }] },
    });
    await expect(archive.listForJob({ module: "skill", jobId: "skill-job" })).resolves.toHaveLength(
      1,
    );
    await expect(archive.listForJob({ module: "knowledge", jobId: "skill-job" })).resolves.toEqual(
      [],
    );
  });

  it("scopes reads by job and treats pruning as best-effort maintenance", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-run-archive-scope-"));
    roots.push(root);
    const maintenanceErrors: unknown[] = [];
    const archive = createMemoryExtractionRunArchive(root, {
      onMaintenanceError: (error) => maintenanceErrors.push(error),
    });
    await archive.save(
      runRecord({
        runId: "1f2c10c7-b876-4b53-b23c-535b09a25815",
        missionId: "6199a039-c9e1-40c3-8645-49f2f2d6770b",
        module: "skill",
        jobId: "skill-job",
      }),
    );
    await archive.save(
      runRecord({
        runId: "3fe0bc0a-f810-45c1-968b-f750496a0d60",
        missionId: "c1d6bf49-9582-45a0-9457-328fbb82c867",
        module: "knowledge",
        jobId: "knowledge-job",
      }),
    );
    const archiveRoot = join(root, "archives", "memory-extraction-runs");
    const knowledgeName = (await readdir(archiveRoot)).find((name) =>
      name.startsWith("knowledge."),
    );
    if (knowledgeName === undefined) throw new Error("Expected a knowledge archive record.");
    await writeFile(join(archiveRoot, knowledgeName), "not-json", "utf8");

    await expect(archive.listForJob({ module: "skill", jobId: "skill-job" })).resolves.toHaveLength(
      1,
    );
    expect(maintenanceErrors).toEqual([]);
    await expect(
      archive.save(
        runRecord({
          runId: "8acbd1fc-5638-445b-b13d-d6c1d4aca4cb",
          missionId: "0f219e89-93fa-47c7-8383-a832224f779f",
          module: "skill",
          jobId: "skill-job",
        }),
      ),
    ).resolves.toBeUndefined();
    expect(maintenanceErrors).toHaveLength(1);
  });
});

function runRecord(input: {
  readonly runId: string;
  readonly missionId: string;
  readonly module: "skill" | "knowledge";
  readonly jobId: string;
}) {
  return {
    schemaVersion: "pragma.desktop-memory-extraction-run/v1" as const,
    ...input,
    status: "succeeded" as const,
    startedAt: "2026-08-05T08:00:00.000Z",
    finishedAt: "2026-08-05T08:00:30.000Z",
    runtimeId: "runtime-a",
  };
}
