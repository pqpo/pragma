import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));

import { capabilitiesApi } from "./capabilities.ts";

const jobId = "00000000-0000-4000-8000-000000000001";
const draftId = "00000000-0000-4000-8000-000000000002";
const hash = "a".repeat(64);

describe("capabilitiesApi Skill revision review", () => {
  beforeEach(() => mocks.invoke.mockReset());

  it("accepts the full 2,000-operation review boundary", async () => {
    const metadata = { sizeBytes: 1, sha256: hash, executable: false };
    const operations = Array.from({ length: 2_000 }, (_, index) => ({
      path: `references/${index}.md`,
      operation: index < 1_000 ? ("deleted" as const) : ("added" as const),
      before: index < 1_000 ? metadata : null,
      after: index < 1_000 ? null : metadata,
    }));
    mocks.invoke.mockResolvedValueOnce({
      jobId,
      draftId,
      baseSnapshotHash: hash,
      candidateSnapshotHash: "b".repeat(64),
      operations,
    });

    await expect(capabilitiesApi.getSkillRevisionReview(jobId)).resolves.toMatchObject({
      operations,
    });
    expect(mocks.invoke).toHaveBeenCalledWith("capabilities:get-skill-revision-review", jobId);
  });

  it("validates a lazily loaded file preview with metadata", async () => {
    const input = { jobId, path: "scripts/run.mjs" };
    const preview = {
      ...input,
      before: {
        sizeBytes: 20,
        sha256: hash,
        executable: false,
        content: "export const run = 1;\n",
        unavailableReason: null,
      },
      after: {
        sizeBytes: 20,
        sha256: "b".repeat(64),
        executable: true,
        content: "export const run = 2;\n",
        unavailableReason: null,
      },
    };
    mocks.invoke.mockResolvedValueOnce(preview);

    await expect(capabilitiesApi.getSkillRevisionReviewFile(input)).resolves.toEqual(preview);
    expect(mocks.invoke).toHaveBeenCalledWith("capabilities:get-skill-revision-review-file", input);
  });
});

it("validates manual Skill saves at the preload IPC boundary", async () => {
  mocks.invoke.mockReset();
  const capability = {
    manifest: {
      schemaVersion: "pragma.capability/v4",
      id: "0000000000sk1rev",
      runtimeKey: "review",
      name: "Review",
      kind: "skill",
      latestRevision: 2,
      activeRevision: 2,
      createdAt: "2026-10-11T00:00:00.000Z",
      updatedAt: "2026-10-11T00:00:00.000Z",
    },
    definition: {
      kind: "skill",
      name: "Review",
      description: "Review code.",
      entryPath: "SKILL.md",
      contentHash: hash,
    },
    health: { revision: 2, status: "ready", checkedAt: "2026-10-11T00:00:00.000Z" },
  };
  const input = {
    id: capability.manifest.id,
    baseRevision: 1,
    files: [{ path: "SKILL.md", content: "# Review" }],
    operations: [
      { kind: "create-directory" as const, path: "references" },
      { kind: "move" as const, path: "notes.md", nextPath: "references/notes.md" },
    ],
  };
  mocks.invoke.mockResolvedValueOnce(capability);
  await expect(capabilitiesApi.saveSkillFiles(input)).resolves.toEqual(capability);
  expect(mocks.invoke).toHaveBeenCalledWith("capabilities:save-skill-files", input);
  mocks.invoke.mockClear();
  await expect(
    capabilitiesApi.saveSkillFiles({
      ...input,
      files: [{ path: "../outside", content: "escape" }],
    }),
  ).rejects.toThrow();
  await expect(
    capabilitiesApi.saveSkillFiles({
      ...input,
      files: [],
      operations: [{ kind: "move", path: "notes.md", nextPath: "../outside.md" }],
    }),
  ).rejects.toThrow();
  expect(mocks.invoke).not.toHaveBeenCalled();
});

it("validates manual history and lazy diffs at the preload boundary", async () => {
  mocks.invoke.mockReset();
  const record = {
    schemaVersion: "pragma.skill-manual-revision/v1",
    capabilityId: "0000000000000001",
    revision: 2,
    baseRevision: 1,
    name: "Review",
    source: "manual",
    createdAt: "2026-10-11T00:00:00.000Z",
    contentHash: hash,
    baseSnapshotHash: hash,
    snapshotHash: "b".repeat(64),
    operations: [],
  };
  mocks.invoke.mockResolvedValueOnce([record]);
  await expect(
    capabilitiesApi.listSkillManualRevisions({ capabilityId: record.capabilityId }),
  ).resolves.toEqual([record]);
  expect(mocks.invoke).toHaveBeenLastCalledWith("capabilities:list-skill-manual-revisions", {
    capabilityId: record.capabilityId,
  });
  const input = { capabilityId: record.capabilityId, revision: 2, path: "references/checklist.md" };
  const preview = {
    ...input,
    before: null,
    after: {
      sizeBytes: 6,
      sha256: hash,
      executable: false,
      content: "Review",
      unavailableReason: null,
    },
  };
  mocks.invoke.mockResolvedValueOnce(preview);
  await expect(capabilitiesApi.getSkillManualRevisionFile(input)).resolves.toEqual(preview);
  mocks.invoke.mockClear();
  await expect(
    capabilitiesApi.getSkillManualRevisionFile({ ...input, path: "../outside" }),
  ).rejects.toThrow();
  expect(mocks.invoke).not.toHaveBeenCalled();
  mocks.invoke.mockResolvedValueOnce([
    { ...record, schemaVersion: "pragma.skill-manual-revision/v99" },
  ]);
  await expect(capabilitiesApi.listSkillManualRevisions()).rejects.toThrow();
});
