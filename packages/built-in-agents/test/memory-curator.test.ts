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
import { z } from "zod";
import { defaultRuntimeTokenCounter } from "@pragma/core";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each([true, false])(
  "advertises provider-compatible fields and persists an episodic receipt with retain=%s",
  async (retain) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-curator-tool-schema-"));
    roots.push(root);
    const store = createMemoryExtractionSessionStore({ pragmaHome: root });
    const session = await store.create({
      module: "episodic",
      watermark: "w",
      input: {
        schemaVersion: "pragma.memory-episodic-extraction-input/v2",
        jobId: "job",
        executionId: "execution",
        omittedEvidence: { records: 0, bytes: 0, byTopic: {} },
        evidence: [
          MemoryEvidenceEnvelopeSchema.parse({
            schemaVersion: "pragma.memory-evidence/v1",
            messageId: "message",
            topic: "execution.message.appended",
            schemaRef: "pragma.memory.execution-message/v2",
            sourceRef: {
              type: "pragma.execution-event",
              id: "event",
              canonicalEventId: "canonical",
            },
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
            payload: { message: { role: "user", text: "Fix the failure, recover and finish." } },
          }),
        ],
      },
    });
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
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      for (const keyword of ["oneOf", "anyOf", "allOf"])
        expect(tool.inputSchema).not.toHaveProperty(keyword);
    }
    async function call(name: string, args: Record<string, unknown>) {
      const tool = tools.find((item) => item.name === name)!;
      // Model the Anthropic SDK boundary, which transmits only root fields.
      const schema = tool.inputSchema as z.core.JSONSchema.JSONSchema;
      const advertised = z.fromJSONSchema({
        type: "object",
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      });
      const result = await tool.call(advertised.parse(args), undefined);
      return result;
    }
    expect((await call("list_evidence", {})).isError).not.toBe(true);
    expect((await call("read_evidence", { evidence: "e1" })).isError).not.toBe(true);
    expect(
      (
        await call("submit_episode_part", {
          part: "goal",
          text: "Fix the failure",
          evidence: ["e1"],
        })
      ).isError,
    ).not.toBe(true);
    const missingPart = await tools
      .find((tool) => tool.name === "submit_episode_part")!
      .call({ text: "Recovered and finished", evidence: ["e1"] }, undefined);
    expect(missingPart).toMatchObject({ isError: true });
    expect(missingPart.text).toContain("part:");
    expect(missingPart.text).toContain("Always supply part and evidence");
    expect(missingPart.text).toContain("Continue in this extraction");
    expect(await session.receipt()).toBeUndefined();
    // The transport exposes optional branch fields; the authoritative union still rejects them.
    expect((await call("submit_episode_part", { part: "goal", evidence: ["e1"] })).isError).toBe(
      true,
    );
    expect(
      (await call("submit_episode_part", { part: "goal", description: "wrong", evidence: ["e1"] }))
        .isError,
    ).toBe(true);
    expect((await call("finish_extraction", { retain: false })).isError).toBe(true);
    expect((await call("finish_extraction", { retain: true, reason: "low-value" })).isError).toBe(
      true,
    );
    const incomplete = await call("finish_extraction", {
      retain: true,
      language: "en",
      valueScore: 0.8,
    });
    expect(incomplete).toMatchObject({ isError: true });
    expect(incomplete.text).toContain("Correction:");
    expect(incomplete.text).toContain("stage goal, summary and outcome");
    expect(incomplete.text).toContain("Successful staged work is preserved");
    expect(await session.receipt()).toBeUndefined();
    for (const args of [
      { part: "summary", text: "Recovered and finished" },
      { part: "attempt", description: "First attempt", result: "Failed" },
      { part: "recovery", failure: "First attempt failed", recovery: "Fixed the issue" },
      { part: "outcome", status: "succeeded", summary: "Finished" },
    ]) {
      expect((await call("submit_episode_part", { ...args, evidence: ["e1"] })).isError).not.toBe(
        true,
      );
    }
    expect(
      (
        await call(
          "finish_extraction",
          retain
            ? { retain: true, language: "en", valueScore: 0.8 }
            : { retain: false, reason: "low-value" },
        )
      ).isError,
    ).not.toBe(true);
    expect((await session.receipt())?.output).toMatchObject(
      retain
        ? {
            retain: true,
            goal: { text: "Fix the failure" },
            attempts: [{ description: "First attempt" }],
          }
        : { retain: false, reason: "low-value" },
    );
    expect(await store.recover("episodic", "job", "w")).toEqual(await session.receipt());
  },
);

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
      const invalid = await submit.call({ wrong: true }, undefined);
      expect(invalid).toMatchObject({ isError: true });
      expect(invalid.text).toContain("arguments_invalid");
      expect(invalid.text).toContain("Correction:");
      expect(invalid.text).toContain("Continue in this extraction");
      const args = {
        statement: "User prefers Chinese",
        subjects: ["user"],
        property: { predicate: "user.preference.language", conflictMode: "exclusive" },
        value: "zh-Hans",
        confidence: 0.8,
        evidence: ["e1"],
      };
      const stringifiedProperty = await submit.call(
        { ...args, property: JSON.stringify(args.property) },
        undefined,
      );
      expect(stringifiedProperty).toMatchObject({ isError: true });
      expect(stringifiedProperty.text).toContain("memory_curator_property_ref_invalid");
      expect(stringifiedProperty.text).toContain("pass a JSON object directly");
      expect(stringifiedProperty.text).toContain("Do not JSON-stringify");
      expect(stringifiedProperty.text).toContain("Continue in this extraction");
      expect(await session.receipt()).toBeUndefined();
      const unread = await submit.call({ ...args, evidence: ["e99"] }, undefined);
      expect(unread).toMatchObject({ isError: true });
      expect(unread.text).toContain("read the cited passages with read_evidence");
      expect((await submit.call(args, undefined)).isError).not.toBe(true);
      await session.setContextBudget(1);
      await expect(
        tools.find((tool) => tool.name === "read_evidence")!.call({ evidence: "e1" }, undefined),
      ).rejects.toThrow("budget_exhausted");
      const finish = tools.find((tool) => tool.name === "finish_extraction")!;
      await expect(finish.call({ retain: true, reason: "low-value" }, undefined)).rejects.toThrow(
        "budget_exhausted",
      );
      expect(await session.receipt()).toBeUndefined();
      expect((await finish.call({ retain: true }, undefined)).isError).not.toBe(true);
      expect((await session.receipt())?.output).toMatchObject({
        retain: true,
        facts: [{ statement: "User prefers Chinese" }],
      });
      await session.setContextBudget(32000);
      const denied = createMemoryCuratorTools(session, async () => {
        throw new Error("memory_curator_tool_content_denied");
      }).find((tool) => tool.name === "submit_fact")!;
      const terminal = await denied.call(args, undefined);
      expect(terminal).toMatchObject({ isError: true });
      expect(terminal.text).not.toContain("Correction:");
      expect(terminal.text).toContain("Stop extraction");
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
  const sessions = createMemoryExtractionSessionStore({ pragmaHome: root });
  const errors = await sessions.create({
    module: "semantic",
    input: { ...input, jobId: "error-accounting" },
    watermark: "w",
  });
  await errors.bindMission("error-accounting-mission");
  const tool = createMemoryCuratorTools(errors).find((entry) => entry.name === "submit_fact")!;
  const firstError = await tool.call({ wrong: true }, undefined);
  const used = defaultRuntimeTokenCounter.countText(firstError.text).tokens;
  expect(used).toBeGreaterThan(0);
  await errors.setContextBudget(used + 1);
  const restored = (await sessions.forMission("error-accounting-mission"))!;
  const restoredTool = createMemoryCuratorTools(restored).find(
    (entry) => entry.name === "submit_fact",
  )!;
  await expect(restoredTool.call({ wrong: true }, undefined)).rejects.toThrow("budget_exhausted");
  expect(await restored.failure()).toBe("memory_curator_budget_exhausted");
});
