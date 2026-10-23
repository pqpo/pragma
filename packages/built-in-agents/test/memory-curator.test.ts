import { getToolResultText } from "@pragma/core";
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, expect, it, vi } from "vitest";
import {
  createMemoryExtractionSessionStore,
  createFileMemoryExtractorProfileStore,
  MemoryExtractionFeedbackSchema,
} from "@pragma/memory";
import { MemoryEvidenceEnvelopeSchema } from "@pragma/shared";
import { PragmaPaths, defaultRuntimeTokenCounter } from "@pragma/core";
import { z } from "zod";
import { createBuiltInMemoryCurator } from "../src/memory-curator.ts";
import { createMemoryCuratorTools } from "../src/memory-curator-tools.ts";
import { memoryCuratorResource } from "../src/builtin.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "pragma-curator-tools-v2-"));
  roots.push(root);
  return root;
}
function input() {
  return {
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
        payload: {
          message: { role: "user", text: "User prefers concise Simplified Chinese answers." },
        },
      }),
    ],
  };
}
const provenance = {
  curatorRef: "expert:0000000000mem0ry",
  promptVersion: "test/v2",
  profileRevision: 0,
  runtimeId: "test",
  providerId: "test",
  modelId: "test",
  extractedAt: "2026-10-19T00:00:00.000Z",
};
const fact = {
  statement: "User prefers Chinese",
  subjects: ["user"],
  predicate: "user.preference.language",
  conflictMode: "exclusive",
  value: "zh-Hans",
  confidence: 0.8,
  evidence: ["e1"],
};
it.each([true, false])(
  "transports provider-compatible schemas and saves episodic retain=%s",
  async (retain) => {
    const root = await home();
    const source = input();
    const session = await createMemoryExtractionSessionStore({ pragmaHome: root }).create({
      module: "episodic",
      watermark: "w",
      input: {
        schemaVersion: "pragma.memory-episodic-extraction-input/v2",
        jobId: "job",
        executionId: "execution",
        evidence: source.evidence,
        omittedEvidence: source.omittedEvidence,
      },
    });
    await session.setProvenance(provenance);
    const tools = createMemoryCuratorTools(session);
    for (const tool of tools) {
      expect(tool.inputSchema).toMatchObject({ type: "object" });
      for (const keyword of ["oneOf", "anyOf", "allOf"])
        expect(tool.inputSchema).not.toHaveProperty(keyword);
    }
    const call = async (name: string, args: Record<string, unknown>) => {
      const tool = tools.find((t) => t.name === name)!;
      const schema = tool.inputSchema as z.core.JSONSchema.JSONSchema;
      const advertised = z.fromJSONSchema({
        type: "object",
        properties: schema.properties ?? {},
        required: schema.required ?? [],
      });
      return await tool.call(advertised.parse(args), undefined);
    };
    expect((await call("read_evidence", {})).isError).not.toBe(true);
    for (const part of ["constructor", "toString", "__proto__", { toString: null }]) {
      const invalid = await tools
        .find((tool) => tool.name === "submit_episode_part")!
        .call({ part, evidence: ["e1"] }, undefined);
      expect(invalid.isError).toBe(true);
      expect(invalid.details).toMatchObject({
        status: "needs_correction",
        code: "memory_curator_arguments_invalid",
      });
      expect(invalid.details).not.toHaveProperty("example");
    }
    const broken = await tools
      .find((t) => t.name === "submit_episode_part")!
      .call({ part: "outcome", evidence: ["e1"] }, undefined);
    expect(broken.isError).toBe(true);
    expect(broken.details).toMatchObject({
      status: "needs_correction",
      requiredFields: expect.arrayContaining(["status", "summary"]),
      example: { part: "outcome", status: "succeeded" },
    });
    const incomplete = await call("finish_episodic_extraction", {
      language: "en",
      valueScore: 0.8,
    });
    expect(incomplete.isError).toBe(true);
    expect(getToolResultText(incomplete)).toContain("Correction:");
    expect(incomplete.details).toMatchObject({
      requiredFields: expect.arrayContaining(["goal", "summary", "outcome"]),
    });
    for (const args of [
      { part: "goal", text: "Record preference" },
      { part: "summary", text: "Preference recorded" },
      { part: "attempt", description: "Read preference", result: "Confirmed" },
      { part: "recovery", failure: "Earlier detail omitted", recovery: "Recovered from source" },
      { part: "outcome", status: "succeeded", summary: "Recorded" },
    ])
      expect((await call("submit_episode_part", { ...args, evidence: ["e1"] })).isError).not.toBe(
        true,
      );
    const done = await call(
      retain ? "finish_episodic_extraction" : "skip_extraction",
      retain
        ? { language: "en", valueScore: 0.8 }
        : { type: "episodic", reason: "no-supported-memory" },
    );
    expect(done.isError).not.toBe(true);
    expect((await session.receipt())?.output).toMatchObject(
      retain
        ? { retain: true, attempts: [{ description: "Read preference" }] }
        : { retain: false, reason: "low-value" },
    );
  },
);
it("repairs typed errors, reads editable candidates and recovers a saved fact receipt without another admission", async () => {
  const root = await home();
  const run = vi.fn(
    async ({
      session,
      prompt,
    }: Parameters<Parameters<typeof createBuiltInMemoryCurator>[0]["execution"]["run"]>[0]) => {
      expect(prompt).toContain("Tool contract: 2");
      await session.setProvenance(provenance);
      const tools = createMemoryCuratorTools(session);
      const submit = tools.find((t) => t.name === "submit_fact")!;
      expect(
        (submit.inputSchema as z.core.JSONSchema.JSONSchema).properties?.property,
      ).toBeUndefined();
      expect(
        (submit.inputSchema as z.core.JSONSchema.JSONSchema).properties?.subjects,
      ).toMatchObject({ items: { enum: ["user"] } });
      const invalid = await submit.call(
        {
          ...fact,
          property: JSON.stringify({ predicate: fact.predicate, conflictMode: fact.conflictMode }),
        },
        undefined,
      );
      expect(invalid.details).toMatchObject({
        status: "needs_correction",
        code: "memory_curator_arguments_invalid",
      });
      const unread = await submit.call(fact, undefined);
      expect(unread.isError).toBe(true);
      expect(getToolResultText(unread)).toContain("read");
      await tools.find((t) => t.name === "read_evidence")!.call({}, undefined);
      const wrong = await submit.call({ ...fact, subjects: ["expert-team"] }, undefined);
      expect(getToolResultText(wrong)).toContain('subject aliases: ["user"]');
      const advertised = z.fromJSONSchema(submit.inputSchema as z.core.JSONSchema.JSONSchema);
      const result = await submit.call(advertised.parse(fact), undefined);
      const metadata = MemoryExtractionFeedbackSchema.parse(result.details);
      expect(metadata.candidate).toBeTruthy();
      const read = await tools
        .find((t) => t.name === "read_staged_candidate")!
        .call({ candidate: metadata.candidate }, undefined);
      expect(getToolResultText(read)).toContain("zh-Hans");
      const fix = await submit.call(
        {
          ...fact,
          candidate: metadata.candidate,
          statement: "User prefers concise Simplified Chinese answers",
        },
        undefined,
      );
      expect(fix.isError).not.toBe(true);
      const denied = createMemoryCuratorTools(session, async () => {
        throw Error("memory_curator_tool_content_denied");
      }).find((t) => t.name === "submit_fact")!;
      const blocked = await denied.call(fact, undefined);
      expect(blocked.details).toMatchObject({
        status: "blocked",
        code: "memory_curator_tool_content_denied",
      });
      expect(blocked.details).not.toHaveProperty("progress");
      const finish = await tools
        .find((t) => t.name === "finish_semantic_extraction")!
        .call({}, undefined);
      expect(finish.isError).not.toBe(true);
      expect((await session.receipt())?.output.retain).toBe(true);
    },
  );
  const curator = createBuiltInMemoryCurator({
    pragmaHome: root,
    profiles: createFileMemoryExtractorProfileStore({ pragmaHome: root }),
    execution: { run },
  });
  expect((await curator.semanticExtractor.extract(input(), { watermark: "w" })).output.retain).toBe(
    true,
  );
  await curator.semanticExtractor.extract(input(), { watermark: "w" });
  expect(run).toHaveBeenCalledOnce();
  expect(await curator.semanticExtractor.recover?.("job", "w")).toMatchObject({
    output: { retain: true },
  });
});
it("budgets actual visible correction text across reopening and preserves a stable terminal code", async () => {
  const root = await home();
  const store = createMemoryExtractionSessionStore({ pragmaHome: root });
  const session = await store.create({ module: "semantic", input: input(), watermark: "errors" });
  await session.bindMission("errors");
  const tool = createMemoryCuratorTools(session).find((t) => t.name === "submit_fact")!;
  const first = await tool.call({ wrong: true }, undefined);
  const used = defaultRuntimeTokenCounter.countText(getToolResultText(first)).tokens;
  expect(used).toBeGreaterThan(0);
  await session.setContextBudget(used + 1);
  const restored = (await store.forMission("errors"))!;
  await expect(
    createMemoryCuratorTools(restored)
      .find((t) => t.name === "submit_fact")!
      .call({ wrong: true }, undefined),
  ).rejects.toThrow("budget_exhausted");
  expect(await restored.failure()).toBe("memory_curator_budget_exhausted");
});
it("uses reserved budget to guide finalization only for already complete supported work", async () => {
  const root = await home();
  const session = await createMemoryExtractionSessionStore({ pragmaHome: root }).create({
    module: "semantic",
    input: input(),
    watermark: "reserve",
  });
  await session.setProvenance(provenance);
  const tools = createMemoryCuratorTools(session);
  const read = tools.find((tool) => tool.name === "read_evidence")!;
  const submitted = tools.find((tool) => tool.name === "submit_fact")!;
  const source = await read.call({}, undefined);
  const staged = await submitted.call(fact, undefined);
  const used =
    defaultRuntimeTokenCounter.countText(getToolResultText(source)).tokens +
    defaultRuntimeTokenCounter.countText(getToolResultText(staged)).tokens;
  await session.setContextBudget(used + 1024);
  const exhausted = await read.call({}, undefined);
  expect(exhausted.details).toMatchObject({
    status: "needs_correction",
    code: "memory_curator_budget_exhausted",
    nextCall: { tool: "finish_semantic_extraction", args: {} },
    progress: { unreadRecords: 0, stagedFacts: 1 },
  });
  expect(
    (await tools.find((tool) => tool.name === "finish_semantic_extraction")!.call({}, undefined))
      .isError,
  ).not.toBe(true);
  expect((await session.receipt())?.output.retain).toBe(true);
  const incomplete = await createMemoryExtractionSessionStore({ pragmaHome: root }).create({
    module: "semantic",
    input: { ...input(), jobId: "unread" },
    watermark: "reserve",
  });
  await incomplete.setContextBudget(1024);
  const blocked = await createMemoryCuratorTools(incomplete)
    .find((tool) => tool.name === "read_evidence")!
    .call({}, undefined);
  expect(blocked.details).toMatchObject({
    status: "blocked",
    code: "memory_curator_budget_exhausted",
  });
  expect(blocked.details).not.toHaveProperty("progress");
});
it("keeps the original DSL and tool vocabulary for a migrated historical Native conversation", async () => {
  const root = await home();
  const path = new PragmaPaths({ pragmaHome: root }).memoryExtractionSessions();
  await mkdir(dirname(path), { recursive: true });
  await copyFile(
    new URL("../../memory/test/fixtures/curator-sessions/v2.sqlite", import.meta.url),
    path,
  );
  const session = (await createMemoryExtractionSessionStore({ pragmaHome: root }).forMission(
    "33333333-3333-4333-a333-333333333333",
  ))!;
  const tools = createMemoryCuratorTools(session);
  expect(tools.map((t) => t.name)).toContain("finish_extraction");
  expect(tools.map((t) => t.name)).not.toContain("finish_episodic_extraction");
  expect(memoryCuratorResource(1).spec.instructions).toContain("finish_extraction");
  expect(memoryCuratorResource(2).spec.instructions).toContain("finish_episodic_extraction");
  expect(
    getToolResultText(
      await tools.find((t) => t.name === "find_existing_memory")!.call({}, undefined),
    ),
  ).toContain("goal");
});
it("accepts the original object property through a migrated historical tool's advertised schema", async () => {
  const root = await home();
  const path = new PragmaPaths({ pragmaHome: root }).memoryExtractionSessions();
  await mkdir(dirname(path), { recursive: true });
  await copyFile(
    new URL("../../memory/test/fixtures/curator-sessions/v1.sqlite", import.meta.url),
    path,
  );
  const session = (await createMemoryExtractionSessionStore({ pragmaHome: root }).forMission(
    "22222222-2222-4222-a222-222222222222",
  ))!;
  expect(session.toolContractVersion).toBe(1);
  const tools = createMemoryCuratorTools(session);
  const submit = tools.find((tool) => tool.name === "submit_fact")!;
  const advertised = z.fromJSONSchema(submit.inputSchema as z.core.JSONSchema.JSONSchema);
  const { predicate, conflictMode, ...fields } = fact;
  const original = { ...fields, property: { predicate, conflictMode } };
  expect(advertised.safeParse(original).success).toBe(true);
  expect(advertised.safeParse({ ...fields, property: "p1" }).success).toBe(true);
  await tools.find((tool) => tool.name === "read_evidence")!.call({}, undefined);
  expect((await submit.call(advertised.parse(original), undefined)).isError).not.toBe(true);
  expect(
    (
      await tools
        .find((tool) => tool.name === "finish_extraction")!
        .call({ retain: true }, undefined)
    ).isError,
  ).not.toBe(true);
  expect((await session.receipt())?.output.retain).toBe(true);
});
