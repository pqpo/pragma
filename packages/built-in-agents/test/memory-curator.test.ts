import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryExtractionSessionStore,
  createFileMemoryExtractorProfileStore,
} from "@pragma/memory";
import { createBuiltInMemoryCurator } from "../src/memory-curator.ts";
import { createMemoryCuratorTools } from "../src/memory-curator-tools.ts";
import { MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("executes through scoped tools and recovers a durable result without parsing assistant JSON or rerunning the model", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-builtin-curator-"));
  roots.push(root);
  const input = {
    schemaVersion: "pragma.memory-semantic-extraction-input/v3" as const,
    jobId: "job",
    executionId: "execution",
    allowedSubjectRefs: [{ type: "pragma.user", id: "user" }],
    currentFacts: [],
    omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
    evidence: [
      MemoryEvidenceEnvelopeSchema.parse({
        schemaVersion: "pragma.memory-evidence/v1",
        messageId: "message",
        topic: "execution.message.appended",
        schemaRef: "pragma.memory.execution-message/v2",
        sourceRef: { type: "pragma.execution-event", id: "event", canonicalEventId: "canonical" },
        subjectRefs: [{ type: "pragma.execution", id: "execution" }],
        occurredAt: "2026-10-14T00:00:00.000Z",
        visibility: { mode: "host-private" },
        sensitivity: "confidential",
        bindings: [],
        policySnapshot: {
          capture: true,
          recall: true,
          learning: "local-candidates",
          appliedRevisions: [],
        },
        payload: { message: { role: "user", text: "User prefers Chinese" } },
      }),
    ],
  };
  const run = vi.fn(
    async ({
      session,
      prompt,
    }: Parameters<Parameters<typeof createBuiltInMemoryCurator>[0]["execution"]["run"]>[0]) => {
      expect(prompt).not.toContain('"schemaVersion"');
      await session.setProvenance({
        curatorRef: "expert:0000000000mem0ry",
        promptVersion: "test/v1",
        profileRevision: 0,
        runtimeId: "test",
        providerId: "test",
        modelId: "test",
        extractedAt: new Date().toISOString(),
      });
      const tools = createMemoryCuratorTools(session);
      const submit = tools.find((tool) => tool.name === "submit_fact")!;
      expect((await submit.call({ wrong: true }, undefined)).text).toContain("arguments_invalid");
      await submit.call(
        {
          statement: "User prefers Chinese",
          subjects: ["user"],
          property: { predicate: "user.preference.language", conflictMode: "exclusive" },
          value: "zh-Hans",
          confidence: 0.8,
          evidence: ["e1"],
        },
        undefined,
      );
      await tools
        .find((tool) => tool.name === "finish_extraction")!
        .call({ retain: true }, undefined);
    },
  );
  const profiles = createFileMemoryExtractorProfileStore({ pragmaHome: root });
  const curator = createBuiltInMemoryCurator({ pragmaHome: root, profiles, execution: { run } });
  expect((await curator.semanticExtractor.extract(input, { watermark: "w" })).output).toMatchObject(
    { retain: true },
  );
  await curator.semanticExtractor.extract(input, { watermark: "w" });
  expect(run).toHaveBeenCalledOnce();
  expect(await curator.semanticExtractor.recover?.("job", "w")).toMatchObject({
    output: { retain: true },
  });
  await expect(
    curator.semanticExtractor.recover?.("job", "w", { ...input, allowedSubjectRefs: [] }),
  ).rejects.toThrow("snapshot_scope_changed");
  expect(
    await createMemoryExtractionSessionStore({ pragmaHome: root }).recover(
      "semantic",
      "job",
      "other",
    ),
  ).toBeUndefined();
});
