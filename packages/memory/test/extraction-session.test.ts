import { CONVERSATION_EXTRACTION_DELAYS } from "../src/pipeline/conversation-extraction-schedule.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths, defaultRuntimeTokenCounter } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractionEvidenceAccessGuard } from "../src/pipeline/extraction-settings.ts";
import { redactMemoryValue } from "../src/evidence/redact.ts";
import { createLegacyExtractionSessionStore as createMemoryExtractionSessionStore } from "./support/legacy-extraction.ts";
import { createSemanticMemoryModule } from "../src/semantic/module.ts";
import { EpisodicMemoryRecordSchema } from "../src/episodic/schema.ts";
import { SemanticExtractionOutputSchema } from "../src/semantic/schema.ts";
import { extractionInput, factArguments, provenance } from "./support/extraction.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(text?: string) {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-curator-session-"));
  roots.push(pragmaHome);
  const store = createMemoryExtractionSessionStore({ pragmaHome });
  const session = await store.create({
    module: "semantic",
    input: extractionInput(text),
    watermark: "watermark",
  });
  await session.setProvenance(provenance);
  return { pragmaHome, store, session };
}
describe("Memory extraction sessions", () => {
  it("allows staging and completion when the evidence delivery budget is exhausted", async () => {
    const { session } = await setup();
    const page = await session.call("list_evidence", {});
    await session.setContextBudget(defaultRuntimeTokenCounter.countText(page).tokens);
    await expect(session.call("list_evidence", {})).rejects.toThrow("budget_exhausted");
    await session.call("submit_fact", factArguments);
    await session.call("finish_extraction", { retain: true });
    expect((await session.receipt())?.output.retain).toBe(true);
  });
  it("revalidates snapshot scope when recovering a durable receipt", async () => {
    const { session, store } = await setup();
    await session.call("submit_fact", factArguments);
    await session.call("finish_extraction", { retain: true });
    await expect(
      store.recover("semantic", "job", "watermark", extractionInput("changed")),
    ).rejects.toThrow("snapshot_scope_changed");
    await expect(
      store.create({
        module: "semantic",
        watermark: "watermark",
        input: { ...extractionInput(), allowedSubjectRefs: [] },
      }),
    ).rejects.toThrow("snapshot_scope_changed");
  });
  it("checks live tool-content consent on each call and preserves no completed receipt after revocation", async () => {
    const { store } = await setup();
    let enabled = true;
    const input = extractionInput();
    input.evidence.push({
      ...input.evidence[0]!,
      messageId: "tool",
      topic: "execution.tool.content",
      schemaRef: "pragma.memory.tool-content/v1",
      payload: {
        toolName: "search",
        phase: "completed",
        completeness: "full",
        text: "private",
        allowedModules: ["semantic"],
      },
    });
    const assertAccess = extractionEvidenceAccessGuard(input.evidence, "semantic", {
      get: async () => ({
        schemaVersion: "pragma.memory-extraction-settings/v1",
        revision: 1,
        allowToolAssisted: { semantic: enabled, episodic: false },
        updatedAt: new Date().toISOString(),
      }),
    });
    const session = await store.create({
      module: "semantic",
      input,
      watermark: "consent",
      assertAccess,
    });
    await session.setProvenance(provenance);
    expect(session.prompt()).not.toContain("private");
    await session.call("read_evidence", { evidence: "e1" });
    await session.call("submit_fact", factArguments);
    enabled = false;
    await expect(session.call("read_evidence", { evidence: "e2" })).rejects.toThrow(
      "tool_content_denied",
    );
    await expect(session.call("finish_extraction", { retain: true })).rejects.toThrow(
      "tool_content_denied",
    );
    expect(await session.receipt()).toBeUndefined();
    expect(await session.failure()).toBe("memory_curator_tool_content_denied");
  });
  it.each([
    "Authorization: Bearer private-credential",
    '{"authorization":"Bearer private-credential"}',
    '{"password":"private credential with spaces"}',
    "password='private credential with spaces'",
    "access_token=private-credential",
    "Bearer private-credential",
  ])("redacts common credential formats: %s", (text) => {
    expect(redactMemoryValue(text)).not.toContain("private");
    expect(redactMemoryValue(text)).toContain("[REDACTED_CREDENTIAL]");
  });
  it.each([
    "PRIVATE KEY",
    "RSA PRIVATE KEY",
    "EC PRIVATE KEY",
    "ENCRYPTED PRIVATE KEY",
    "OPENSSH PRIVATE KEY",
  ])("redacts %s blocks and truncated previews", (label) => {
    const block = `-----BEGIN ${label}-----\nc3ludGhldGljLXByaXZhdGUtYnl0ZXM=\n-----END ${label}-----`;
    expect(redactMemoryValue(`before\n${block}\nafter`)).toBe(
      "before\n[REDACTED_PRIVATE_KEY]\nafter",
    );
    expect(redactMemoryValue(block.slice(0, block.indexOf("-----END")))).toBe(
      "[REDACTED_PRIVATE_KEY]",
    );
  });
  it.each(["ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", "glpat-", "xoxb-", "xoxp-"])(
    "redacts standalone %s credentials recursively",
    (prefix) => {
      const credential = prefix + "A".repeat(40);
      expect(redactMemoryValue({ text: [credential] })).toEqual({
        text: ["[REDACTED_CREDENTIAL]"],
      });
    },
  );
  it("reads 130 records in one legacy admission and materializes a Fact", async () => {
    const { pragmaHome, store } = await setup();
    const source = { type: "pragma.expert", id: "expert-a" };
    const base = {
      ...extractionInput().evidence[0]!,
      attribution: { rootRef: source, producerRefs: [source] },
      bindings: [{ consumerRef: source, access: "allow" as const }],
    };
    const messages = Array.from({ length: 130 }, (_, index) => ({
      ...base,
      messageId: `message-${index}`,
      payload: {
        message: {
          role: "user",
          text: `Record ${index}: user prefers Chinese answers and concise explanations.`,
        },
      },
    }));
    let admissions = 0;
    let clock = new Date();
    const module = await createSemanticMemoryModule({
      pragmaHome,
      now: () => clock,
      extractor: {
        extract: async (input, options) => {
          admissions++;
          const session = await store.create({
            ...options,
            module: "semantic",
            input,
            watermark: options!.watermark!,
          });
          await session.setProvenance(provenance);
          expect(session.prompt()).not.toContain("[e1] user");
          let evidence = "e1";
          const read = new Set<string>();
          let calls = 0;
          while (evidence !== "end" && calls < 64) {
            const page = await session.call("read_evidence", {});
            calls++;
            expect(defaultRuntimeTokenCounter.countText(page).tokens).toBeLessThanOrEqual(2000);
            for (const match of page.matchAll(/Record (\d+):/gu)) read.add(match[1]!);
            evidence = /Next evidence: (e\d+|end)/u.exec(page)![1]!;
          }
          expect(evidence).toBe("end");
          expect(read.size).toBe(130);
          expect(calls).toBeLessThan(64);
          await session.call("submit_fact", factArguments);
          await session.call("finish_extraction", { retain: true });
          const receipt = (await session.receipt())!;
          return { ...receipt, output: SemanticExtractionOutputSchema.parse(receipt.output) };
        },
      },
    });
    try {
      await module.registerExecutionSubjects({
        executionId: "execution",
        subjectRefs: [{ type: "pragma.user", id: "local-user" }],
      });
      await module.consume([
        ...messages,
        {
          ...base,
          messageId: "terminal",
          topic: "execution.execution.terminal",
          schemaRef: "pragma.memory.execution-terminal/v2",
          payload: { outcome: "succeeded" },
        },
      ]);
      await module.setConversationState({
        conversationRef: { type: "pragma.execution", id: "execution" },
        state: "completed",
        now: clock,
      });
      clock = new Date(clock.getTime() + CONVERSATION_EXTRACTION_DELAYS.completedMs);
      await module.runBackgroundOnce?.();
      expect(admissions).toBe(1);
      expect(await module.store.list()).toHaveLength(1);
      expect((await module.store.listExtractionJobs())[0]).toMatchObject({
        status: "completed",
        completion: "retained",
        attempts: 1,
      });
    } finally {
      module.close();
    }
  }, 20000);
  it("uses a short readable task and durable idempotent fact receipt", async () => {
    const { pragmaHome, session } = await setup();
    expect(session.prompt()).toContain("[e1] user");
    expect(session.prompt()).not.toContain('"schemaVersion"');
    const candidate = await session.call("submit_fact", factArguments);
    expect(await session.call("submit_fact", factArguments)).toBe(candidate);
    await session.call("finish_extraction", { retain: true });
    const reopened = createMemoryExtractionSessionStore({ pragmaHome });
    const result = await reopened.recover("semantic", "job", "watermark");
    expect(result).toMatchObject({
      output: {
        retain: true,
        facts: [
          {
            subjectRefs: [{ type: "pragma.user", id: "local-user" }],
            evidenceRefs: ["message"],
            predicate: "user.preference.language",
          },
        ],
      },
      provenance,
    });
    expect(await reopened.recover("semantic", "job", "other-watermark")).toBeUndefined();
    expect(await session.call("finish_extraction", { retain: true })).toContain("already finished");
  });
  it("resumes legacy source fragments without dropping text", async () => {
    const text = "中".repeat(28000);
    const { session, store } = await setup(text);
    await session.bindMission("large-source");
    expect(defaultRuntimeTokenCounter.countText(session.prompt()).tokens).toBeLessThanOrEqual(1500);
    await expect(session.call("submit_fact", factArguments)).rejects.toThrow("evidence_not_read");
    await expect(
      session.call("finish_extraction", { retain: false, reason: "insufficient-evidence" }),
    ).rejects.toThrow("evidence_incomplete");
    let cursor = 0;
    let combined = "";
    let exhausted = false;
    for (let turn = 0; turn < 40; turn++) {
      // Alternate explicit cursors with automatic resumption, including after reopening.
      const current = turn % 2 === 0 ? session : (await store.forMission("large-source"))!;
      const result = await current.call(
        "read_evidence",
        turn % 2 === 0 ? {} : { evidence: "e1", cursor },
      );
      expect(defaultRuntimeTokenCounter.countText(result).tokens).toBeLessThanOrEqual(2000);
      combined += result.split("\n").slice(1, -1).join("\n");
      const next = /Next cursor: (\d+|end)/u.exec(result)![1]!;
      if (next === "end") {
        exhausted = true;
        break;
      }
      cursor = Number(next);
    }
    expect(exhausted).toBe(true);
    expect(combined).toBe(text);
    await session.call("submit_fact", factArguments);
    await session.call("finish_extraction", { retain: true });
  }, 15000);
  it("returns validation errors in the same session and allows candidate correction", async () => {
    const { session } = await setup();
    await expect(
      session.call("submit_fact", { ...factArguments, subjects: ["invented"] }),
    ).rejects.toThrow("subject_ref_invalid");
    await expect(
      session.call("submit_fact", { ...factArguments, evidence: ["e99"] }),
    ).rejects.toThrow("evidence_not_read");
    const result = await session.call("submit_fact", factArguments);
    const candidate = /Candidate (c\w+)/u.exec(result)![1];
    await session.call("submit_fact", {
      ...factArguments,
      candidate,
      statement: "更准确的偏好描述。",
    });
    await session.call("finish_extraction", { retain: true });
    expect((await session.receipt())?.output).toMatchObject({
      facts: [{ statement: "更准确的偏好描述。" }],
    });
  });
  it("automatically fills reading gaps without redelivering adjacent completed passages", async () => {
    const { store } = await setup();
    const input = extractionInput();
    input.evidence = ["甲", "乙", "丙"].map((text, index) => ({
      ...input.evidence[0]!,
      messageId: `gap-${index}`,
      payload: { message: { role: "user", text: text.repeat(800) } },
    }));
    const session = await store.create({ module: "semantic", input, watermark: "gaps" });
    expect(session.prompt()).not.toContain("Source text (also available");
    await session.call("read_evidence", { evidence: "e3" });
    let combined = "";
    for (let page = 0; page < 5; page++) {
      const text = await session.call("read_evidence", {});
      combined += text;
      if (text.includes("Next evidence: end;")) break;
    }
    expect(combined).toContain("[e1]");
    expect(combined).toContain("[e2]");
    expect(combined).not.toContain("[e3]");
    expect(combined).toContain("Next evidence: end;");
  });
  it("binds the session to a Mission, rejects stale claims and preserves staged work on cancellation", async () => {
    const { store, session } = await setup();
    await session.bindMission("mission");
    const restored = await store.forMission("mission", { isCurrent: async () => false });
    await expect(restored!.call("read_evidence", { evidence: "e1" })).rejects.toThrow(
      "claim_stale",
    );
    const controller = new AbortController();
    controller.abort();
    const cancelled = await store.forMission("mission", { signal: controller.signal });
    await expect(cancelled!.call("read_evidence", { evidence: "e1" })).rejects.toThrow();
    expect(await session.receipt()).toBeUndefined();
  });
  it("parks exhausted budgets without recording a rejection and supports explicit retry", async () => {
    const { session, store } = await setup("source ".repeat(10000));
    await session.setContextBudget(1);
    await expect(session.call("read_evidence", { evidence: "e1" })).rejects.toThrow(
      "budget_exhausted",
    );
    expect(await session.failure()).toBe("memory_curator_budget_exhausted");
    expect(await session.receipt()).toBeUndefined();
    const retry = await store.create({
      module: "semantic",
      input: extractionInput("source ".repeat(10000)),
      watermark: "watermark",
    });
    await retry.setContextBudget(32000);
    expect(await retry.call("read_evidence", { evidence: "e1" })).toContain("source");
  });
  it("queries related facts through the injected scope and validates replacement revision before staging", async () => {
    const { store } = await setup();
    const fact = {
      id: "fact",
      revision: 2,
      statement: "User prefers English",
      subjectRefs: [{ type: "pragma.user", id: "local-user" }],
      predicate: "user.preference.language",
      normalizedValue: "en",
      conflictMode: "exclusive" as const,
      observedAt: "2026-10-13T00:00:00.000Z",
    };
    const session = await store.create({
      module: "semantic",
      input: extractionInput(),
      watermark: "new",
      findFacts: async () => [fact],
      canUseFact: async () => false,
    });
    expect(await session.call("find_existing_memory", { query: "language" })).toContain("[f1]");
    await expect(
      session.call("submit_fact", { ...factArguments, property: "p1", replaces: "f1" }),
    ).rejects.toThrow("stale_or_denied");
  });
  it.each(["denied", "expired", "revised"])(
    "rejects a %s property handle without a replacement",
    async (condition) => {
      const { store } = await setup();
      const fact = {
        id: "fact",
        revision: 2,
        statement: "User prefers English",
        subjectRefs: [{ type: "pragma.user", id: "local-user" }],
        predicate: "user.preference.language",
        normalizedValue: "en",
        conflictMode: "exclusive" as const,
        observedAt: provenance.extractedAt,
      };
      let currentRevision: number | undefined = 2;
      const session = await store.create({
        module: "semantic",
        input: extractionInput(),
        watermark: condition,
        findFacts: async () => [fact],
        canUseFact: async (_, revision) => revision === currentRevision,
      });
      await session.setProvenance(provenance);
      await session.call("find_existing_memory", {});
      currentRevision = condition === "revised" ? 3 : undefined;
      await expect(
        session.call("submit_fact", { ...factArguments, property: "p1" }),
      ).rejects.toThrow("stale_or_denied");
      await expect(session.call("finish_extraction", { retain: true })).rejects.toThrow();
      expect(await session.receipt()).toBeUndefined();
    },
  );
  it("pages every previous episode section without dropping attempts or recoveries", async () => {
    const { store } = await setup();
    const input = extractionInput();
    const timestamp = "2026-10-14T00:00:00.000Z";
    const previous = EpisodicMemoryRecordSchema.parse({
      schemaVersion: "pragma.memory-episodic/v3",
      id: "previous",
      revision: 1,
      conversationRef: { type: "pragma.execution", id: "execution" },
      sourceExecutionIds: ["execution"],
      sourceUpdatedAt: timestamp,
      executionId: "execution",
      terminalMessageId: "previous-terminal",
      rootRefs: [],
      producerRefs: [],
      language: "zh-Hans",
      goal: { text: "目".repeat(4000), evidenceRefs: ["old"] },
      summary: { text: "摘".repeat(4000), evidenceRefs: ["old"] },
      attempts: [{ description: "unique-attempt", result: "unique-result", evidenceRefs: ["old"] }],
      failuresAndRecoveries: [
        { failure: "unique-failure", recovery: "unique-recovery", evidenceRefs: ["old"] },
      ],
      outcome: { status: "succeeded", summary: "unique-outcome", evidenceRefs: ["old"] },
      artifactRefs: [],
      evidenceRefs: ["old"],
      visibility: { mode: "host-private" },
      sensitivity: "confidential",
      bindings: [
        {
          consumerRef: { type: "pragma.expert", id: "expert" },
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
      valueScore: 0.8,
      status: "active",
      extractor: provenance,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    const session = await store.create({
      module: "episodic",
      watermark: "paged",
      input: {
        schemaVersion: "pragma.memory-episodic-extraction-input/v2",
        jobId: "paged",
        executionId: "execution",
        evidence: input.evidence,
        omittedEvidence: input.omittedEvidence,
        previousEpisode: previous,
      },
    });
    let cursor = 0;
    let combined = "";
    for (let index = 0; index < 20; index++) {
      const text = await session.call("find_existing_memory", { cursor });
      expect(defaultRuntimeTokenCounter.countText(text).tokens).toBeLessThanOrEqual(2000);
      combined += text;
      const next = /Next cursor: (end|\d+)/u.exec(text)![1]!;
      if (next === "end") break;
      expect(Number(next)).toBeGreaterThan(cursor);
      cursor = Number(next);
    }
    for (const term of [
      "unique-attempt",
      "unique-result",
      "unique-failure",
      "unique-recovery",
      "unique-outcome",
    ])
      expect(combined).toContain(term);
  });
  it("does not admit fact handles that were omitted from the delivered page", async () => {
    const { store } = await setup();
    const session = await store.create({
      module: "semantic",
      input: extractionInput(),
      watermark: "handles",
      findFacts: async () =>
        Array.from({ length: 10 }, (_, index) => ({
          id: `fact-${index}`,
          revision: 1,
          statement: "长".repeat(400),
          subjectRefs: [{ type: "pragma.user", id: "local-user" }],
          predicate: "user.preference.test",
          normalizedValue: "值".repeat(200),
          conflictMode: "compatible" as const,
          observedAt: provenance.extractedAt,
        })),
    });
    const page = await session.call("find_existing_memory", {});
    const handles = [...page.matchAll(/\[f(\d+)\]/gu)].map((match) => Number(match[1]));
    expect(handles.length).toBeGreaterThan(0);
    expect(handles.length).toBeLessThan(10);
    await expect(
      session.call("find_existing_memory", { fact: `f${Math.max(...handles) + 1}` }),
    ).rejects.toThrow("fact_ref_invalid");
  });
  it("rejects an Episode with too many aggregate citations before writing its receipt", async () => {
    const { pragmaHome, store } = await setup();
    const input = extractionInput();
    const evidence = Array.from({ length: 501 }, (_, index) => ({
      ...input.evidence[0]!,
      messageId: `source-${index}`,
    }));
    const session = await store.create({
      module: "episodic",
      watermark: "citations",
      input: {
        schemaVersion: "pragma.memory-episodic-extraction-input/v2",
        jobId: "citations",
        executionId: "execution",
        evidence,
        omittedEvidence: input.omittedEvidence,
      },
    });
    await session.setProvenance(provenance);
    // A resumed session may accumulate read coverage across multiple bounded admissions.
    const db = new DatabaseSync(new PragmaPaths({ pragmaHome }).memoryExtractionSessions());
    try {
      const row = db.prepare("SELECT state_json FROM sessions WHERE key = ?").get(session.key) as {
        state_json: string;
      };
      const state = JSON.parse(row.state_json);
      state.read = Object.fromEntries(
        evidence.map((item, index) => [
          `e${index + 1}`,
          [[0, (item.payload as { message: { text: string } }).message.text.length]],
        ]),
      );
      db.prepare("UPDATE sessions SET state_json = ? WHERE key = ?").run(
        JSON.stringify(state),
        session.key,
      );
    } finally {
      db.close();
    }
    const aliases = evidence.map((_, index) => `e${index + 1}`);
    for (const part of ["goal", "summary"])
      await session.call("submit_episode_part", {
        part,
        text: part,
        evidence: aliases.slice(0, 100),
      });
    await session.call("submit_episode_part", {
      part: "outcome",
      status: "succeeded",
      summary: "done",
      evidence: aliases.slice(0, 100),
    });
    for (let cursor = 100; cursor < aliases.length; cursor += 100)
      await session.call("submit_episode_part", {
        part: "attempt",
        description: `attempt-${cursor}`,
        evidence: aliases.slice(cursor, cursor + 100),
      });
    await expect(
      session.call("finish_extraction", { retain: true, language: "en", valueScore: 0.8 }),
    ).rejects.toMatchObject({ issues: [{ code: "too_big", maximum: 500 }] });
    expect(await session.receipt()).toBeUndefined();
  });
  it("composes an Episode from individually validated parts", async () => {
    const { store } = await setup();
    const input = extractionInput();
    const session = await store.create({
      module: "episodic",
      input: {
        schemaVersion: "pragma.memory-episodic-extraction-input/v2",
        jobId: "episode",
        executionId: input.executionId,
        evidence: input.evidence,
        omittedEvidence: input.omittedEvidence,
      },
      watermark: "episode",
    });
    await session.setProvenance(provenance);
    await session.call("submit_episode_part", {
      part: "goal",
      text: "Remember preference",
      evidence: ["e1"],
    });
    await expect(
      session.call("finish_extraction", { retain: true, language: "zh-Hans", valueScore: 0.8 }),
    ).rejects.toThrow();
    await session.call("submit_episode_part", {
      part: "summary",
      text: "User stated a preference",
      evidence: ["e1"],
    });
    await session.call("submit_episode_part", {
      part: "outcome",
      status: "succeeded",
      summary: "Recorded",
      evidence: ["e1"],
    });
    await session.call("finish_extraction", { retain: true, language: "zh-Hans", valueScore: 0.8 });
    expect((await session.receipt())?.output).toMatchObject({
      retain: true,
      goal: { evidenceRefs: ["message"] },
      attempts: [],
    });
  });
  it("settles a durable receipt after an expired running lease without another extractor admission", async () => {
    const { pragmaHome, store } = await setup();
    let clock = new Date("2026-10-15T00:00:00.000Z");
    const source = { type: "pragma.expert", id: "expert-a" };
    const message = {
      ...extractionInput().evidence[0]!,
      attribution: { rootRef: source, producerRefs: [source] },
      bindings: [{ consumerRef: source, access: "allow" as const }],
    };
    const terminal = {
      ...message,
      messageId: "terminal",
      topic: "execution.execution.terminal",
      schemaRef: "pragma.memory.execution-terminal/v2",
      payload: { outcome: "succeeded" },
    };
    let module = await createSemanticMemoryModule({ pragmaHome, now: () => clock });
    await module.registerExecutionSubjects({
      executionId: "execution",
      subjectRefs: [{ type: "pragma.user", id: "local-user" }],
    });
    await module.consume([message, terminal]);
    await module.setConversationState({
      conversationRef: { type: "pragma.execution", id: "execution" },
      state: "completed",
      now: clock,
    });
    clock = new Date(clock.getTime() + CONVERSATION_EXTRACTION_DELAYS.completedMs);
    const job = (await module.store.claimDueJob(clock))!;
    expect(job).toBeDefined();
    const session = await store.create({
      module: "semantic",
      input: { ...extractionInput(undefined, job.id), evidence: [message, terminal] },
      watermark: job.inputWatermark,
    });
    await session.setProvenance(provenance);
    await session.call("submit_fact", factArguments);
    await session.call("finish_extraction", { retain: true });
    module.close();
    clock = new Date(clock.getTime() + 6 * 60_000);
    const extract = vi.fn(async () => {
      throw new Error("A completed model must not be rerun.");
    });
    module = await createSemanticMemoryModule({
      pragmaHome,
      now: () => clock,
      extractor: {
        extract,
        recover: async (jobId, watermark) => {
          const receipt = await store.recover("semantic", jobId, watermark);
          return receipt === undefined
            ? undefined
            : { ...receipt, output: SemanticExtractionOutputSchema.parse(receipt.output) };
        },
      },
    });
    await module.runBackgroundOnce?.();
    expect(extract).not.toHaveBeenCalled();
    expect(await module.store.list()).toHaveLength(1);
    expect((await module.store.listExtractionJobs())[0]).toMatchObject({
      status: "completed",
      completion: "retained",
      attempts: 1,
    });
    module.close();
  });

  it("cleans session snapshots with execution deletion and rejects future state versions", async () => {
    const { pragmaHome, store, session } = await setup();
    await session.bindMission("mission");
    await store.deleteExecutions(["execution"]);
    expect(await store.forMission("mission")).toBeUndefined();
    const db = new DatabaseSync(new PragmaPaths({ pragmaHome }).memoryExtractionSessions());
    db.exec("PRAGMA user_version = 99");
    db.close();
    await expect(store.recover("semantic", "job", "watermark")).rejects.toThrow(
      "version_unsupported",
    );
  });
});
