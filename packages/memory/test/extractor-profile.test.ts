import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createFileMemoryExtractorProfileStore } from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Memory extractor profile", () => {
  it("defaults to inheritance and persists a CAS-protected pinned selection", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-memory-profile-"));
    roots.push(root);
    const store = createFileMemoryExtractorProfileStore({
      pragmaHome: root,
      now: () => new Date("2026-08-01T00:00:00.000Z"),
    });
    await expect(store.get()).resolves.toMatchObject({ revision: 0, mode: "inherit-default" });
    await expect(
      store.update({
        expectedRevision: 0,
        profile: {
          mode: "pinned",
          runtimeId: "runtime-a",
          providerId: "provider-a",
          modelId: "model-a",
          thinkingLevel: "high",
        },
      }),
    ).resolves.toMatchObject({ revision: 1, mode: "pinned", modelId: "model-a" });
    await expect(
      store.update({ expectedRevision: 0, profile: { mode: "inherit-default" } }),
    ).rejects.toThrow("memory_extractor_profile_revision_conflict");
    await expect(
      createFileMemoryExtractorProfileStore({ pragmaHome: root }).get(),
    ).resolves.toMatchObject({ revision: 1, runtimeId: "runtime-a" });
  });
});
