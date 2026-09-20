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
