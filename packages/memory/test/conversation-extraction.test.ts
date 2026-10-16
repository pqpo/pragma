import { copyFile, mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PragmaPaths } from "@pragma/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createMemoryExtractionSessionStore,
  ConversationExtractionInputSchema,
} from "../src/pipeline/extraction-session.ts";
import { hasMemoryExtractionReceipt } from "../src/pipeline/extraction-session/store.ts";
import { extractionInput, factArguments, provenance } from "./support/extraction.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function home() {
  const root = await mkdtemp(join(tmpdir(), "pragma-shared-extraction-"));
  roots.push(root);
  return root;
}
function input() {
  return ConversationExtractionInputSchema.parse({
    ...extractionInput(),
    schemaVersion: "pragma.memory-conversation-extraction-input/v1",
    jobId: "conversation-job",
    targets: ["episodic", "semantic"],
    evidenceTypes: { message: ["episodic", "semantic"] },
    jobs: {
      episodic: { jobId: "episode-job", watermark: "w" },
      semantic: { jobId: "fact-job", watermark: "w" },
    },
  });
}
describe("shared conversation extraction", () => {
  it("reads once, saves types independently and recovers receipts without another model", async () => {
    const pragmaHome = await home();
    const store = createMemoryExtractionSessionStore({ pragmaHome });
    const onResult = vi.fn(async () => {});
    const session = await store.create({
      module: "conversation",
      input: input(),
      watermark: "w",
      onResult,
    });
    await session.setProvenance(provenance);
    await session.call("read_evidence", { evidence: "e1" });
    await session.call("submit_fact", factArguments);
    await expect(session.call("finish_extraction", { retain: true })).rejects.toThrow(
      "type_required",
    );
    await session.call("finish_extraction", { type: "semantic", retain: true });
    expect(await session.completed()).toBe(false);
    expect(await session.pendingTypes()).toEqual(["episodic"]);
    expect((await session.receiptFor("semantic"))?.output.retain).toBe(true);
    expect(await session.receipt()).toBeUndefined();
    expect(hasMemoryExtractionReceipt({ pragmaHome }, "semantic", "fact-job", "w")).toBe(true);
    expect((await store.recover("semantic", "fact-job", "w"))?.output.retain).toBe(true);
    await expect(session.call("submit_fact", factArguments)).rejects.toThrow(
      "type_already_finished",
    );
    // Restoring does not clear evidence coverage or the first receipt.
    const resumed = await store.forMission("missing");
    expect(resumed).toBeUndefined();
    const restored = await store.create({ module: "conversation", input: input(), watermark: "w" });
    for (const part of ["goal", "summary"] as const)
      await restored.call("submit_episode_part", {
        part,
        text: "A useful episode",
        evidence: ["e1"],
      });
    await restored.call("submit_episode_part", {
      part: "outcome",
      status: "succeeded",
      summary: "Completed",
      evidence: ["e1"],
    });
    await restored.call("finish_extraction", {
      type: "episodic",
      retain: true,
      language: "en",
      valueScore: 0.8,
    });
    expect(await restored.completed()).toBe(true);
    expect((await restored.receiptFor("episodic"))?.output.retain).toBe(true);
    expect(onResult).toHaveBeenCalledWith(
      "semantic",
      expect.objectContaining({ output: expect.objectContaining({ retain: true }) }),
    );
  });

  it.each([
    [true, false],
    [false, true],
    [false, false],
  ])("allows independent decisions: episodic=%s semantic=%s", async (episode, fact) => {
    const store = createMemoryExtractionSessionStore({ pragmaHome: await home() });
    const session = await store.create({ module: "conversation", input: input(), watermark: "w" });
    await session.setProvenance(provenance);
    await session.call("read_evidence", { evidence: "e1" });
    if (fact) await session.call("submit_fact", factArguments);
    await session.call(
      "finish_extraction",
      fact
        ? { type: "semantic", retain: true }
        : { type: "semantic", retain: false, reason: "no-stable-fact" },
    );
    if (episode) {
      for (const part of ["goal", "summary"] as const)
        await session.call("submit_episode_part", {
          part,
          text: "Reusable incident",
          evidence: ["e1"],
        });
      await session.call("submit_episode_part", {
        part: "outcome",
        status: "succeeded",
        summary: "Resolved",
        evidence: ["e1"],
      });
    }
    await session.call(
      "finish_extraction",
      episode
        ? { type: "episodic", retain: true, language: "en", valueScore: 0.8 }
        : { type: "episodic", retain: false, reason: "low-value" },
    );
    expect(await session.completed()).toBe(true);
    expect((await session.receiptFor("semantic"))?.output.retain).toBe(fact);
    expect((await session.receiptFor("episodic"))?.output.retain).toBe(episode);
  });

  it("persists one idempotent continuation reservation and a shared three-prompt budget", async () => {
    const pragmaHome = await home();
    const store = createMemoryExtractionSessionStore({ pragmaHome });
    let session = await store.create({ module: "conversation", input: input(), watermark: "w" });
    await session.bindMission("11111111-1111-4111-a111-111111111111");
    await expect(session.bindMission("22222222-2222-4222-a222-222222222222")).rejects.toThrow(
      "already_bound",
    );
    for (let count = 1; count <= 3; count++) {
      const pending = await session.reserveContinuation({
        previousExecutionId: `execution-${count}`,
        prompt: "Continue pending type",
      });
      expect(
        await session.reserveContinuation({ previousExecutionId: "ignored", prompt: "ignored" }),
      ).toEqual(pending);
      expect((await session.executionState()).continuations).toBe(count);
      session = await store.create({ module: "conversation", input: input(), watermark: "w" });
      expect((await session.executionState()).pendingContinuation).toEqual(pending);
      await session.acknowledgeContinuation(pending.requestId);
    }
    await expect(
      session.reserveContinuation({ previousExecutionId: "fourth", prompt: "Again" }),
    ).rejects.toThrow("continuations_exhausted");
    await session.setContextBudget(1);
    await expect(session.call("list_evidence", {})).rejects.toThrow("budget_exhausted");
    const db = new DatabaseSync(new PragmaPaths({ pragmaHome }).memoryExtractionSessions());
    const before = JSON.parse(
      (db.prepare("SELECT state_json FROM sessions").get() as { state_json: string }).state_json,
    );
    await store.create({ module: "conversation", input: input(), watermark: "w" });
    const after = JSON.parse(
      (db.prepare("SELECT state_json FROM sessions").get() as { state_json: string }).state_json,
    );
    expect(after.calls).toBe(before.calls);
    expect(after.tokenLimit).toBe(1);
    db.close();
  });

  it("rejects evidence authorized only for the other type", async () => {
    const source = input();
    source.evidenceTypes.message = ["episodic"];
    const session = await createMemoryExtractionSessionStore({ pragmaHome: await home() }).create({
      module: "conversation",
      input: source,
      watermark: "w",
    });
    await session.setProvenance(provenance);
    await session.call("read_evidence", { evidence: "e1" });
    await expect(session.call("submit_fact", factArguments)).rejects.toThrow(
      "evidence_type_denied",
    );
  });

  it("rechecks consent for earlier Native context and never redelivers a completed type's private evidence after restart", async () => {
    const store = createMemoryExtractionSessionStore({ pragmaHome: await home() });
    const source = input();
    source.evidence.push({
      ...source.evidence[0]!,
      messageId: "semantic-tool",
      topic: "execution.tool.content",
      schemaRef: "pragma.memory.tool-content/v1",
      payload: {
        toolName: "lookup",
        phase: "completed",
        completeness: "full",
        text: "private-semantic-content",
        allowedModules: ["semantic"],
      },
    });
    source.evidenceTypes["semantic-tool"] = ["semantic"];
    let semanticEnabled = true;
    const assertEvidenceAccess = async (
      evidence: readonly { messageId: string }[],
      type: string,
    ) => {
      if (
        type === "semantic" &&
        !semanticEnabled &&
        evidence.some((item) => item.messageId === "semantic-tool")
      )
        throw new Error("memory_curator_tool_content_denied");
    };
    const original = await store.create({
      module: "conversation",
      input: source,
      watermark: "all",
      activeTypes: ["episodic", "semantic"],
      assertEvidenceAccess,
    });
    await original.setProvenance(provenance);
    await original.call("read_evidence", { evidence: "e1" });
    await original.call("finish_extraction", {
      type: "semantic",
      retain: false,
      reason: "no-stable-fact",
    });
    const pending = {
      ...source,
      targets: ["episodic"] as ["episodic"],
      jobs: { episodic: source.jobs.episodic },
      evidence: source.evidence.slice(0, 1),
      evidenceTypes: { message: ["episodic"] as ["episodic"] },
    };
    const resume = () =>
      store.create({
        module: "conversation",
        input: pending,
        watermark: "pending",
        activeTypes: ["episodic"],
        assertEvidenceAccess,
      });
    const continuation = await resume();
    expect(continuation.key).toBe(original.key);
    await expect(continuation.call("read_evidence", { evidence: "e2" })).rejects.toThrow(
      "evidence_type_denied",
    );
    semanticEnabled = false;
    await expect((await resume()).assertCurrent()).rejects.toThrow("tool_content_denied");
    await store.retryConversation(source.jobId, true, ["episodic"]);
    const fresh = await resume();
    await fresh.assertCurrent();
    expect(fresh.key).not.toBe(original.key);
    expect(fresh.prompt()).not.toContain("private-semantic-content");
    expect(await fresh.call("list_evidence", {})).not.toContain("semantic-tool");
    expect(await fresh.call("read_evidence", { evidence: "e1" })).not.toContain(
      "private-semantic-content",
    );
    await expect(fresh.call("read_evidence", { evidence: "e2" })).rejects.toThrow(
      "evidence_ref_invalid",
    );
  });

  it("continues the same snapshot when only the unfinished delivery is prepared, and distinguishes manual retry generations", async () => {
    const store = createMemoryExtractionSessionStore({ pragmaHome: await home() });
    const session = await store.create({
      module: "conversation",
      input: input(),
      watermark: "both",
    });
    await session.setProvenance(provenance);
    await session.call("read_evidence", { evidence: "e1" });
    await session.bindMission("original");
    await session.markAdmitted();
    await session.call("submit_fact", factArguments);
    await session.call("finish_extraction", { type: "semantic", retain: true });
    const old = await session.reserveContinuation({
      previousExecutionId: "first",
      prompt: "Continue",
    });
    await session.acknowledgeContinuation(old.requestId);
    await store.retryConversation("conversation-job");
    const next = await session.reserveContinuation({
      previousExecutionId: "first",
      prompt: "Continue",
    });
    expect(next.requestId).not.toBe(old.requestId);
    await store.retryConversation("conversation-job");
    expect(
      await session.reserveContinuation({
        previousExecutionId: "uncertain",
        prompt: "must replay the pending command",
      }),
    ).toEqual(next);
    const source = input();
    source.targets = ["episodic"];
    delete source.jobs.semantic;
    source.evidenceTypes.message = ["episodic"];
    const restored = await store.create({
      module: "conversation",
      input: source,
      watermark: "pending-only",
    });
    expect(restored.key).toBe(session.key);
    expect((await restored.executionState()).missionId).toBe("original");
    expect(await restored.pendingTypes()).toEqual(["episodic"]);
    await store.retryConversation("conversation-job", true, ["episodic"]);
    expect(await restored.executionState()).toMatchObject({ admitted: false, continuations: 0 });
    expect((await restored.executionState()).missionId).toBeUndefined();
    expect((await restored.receiptFor("semantic"))?.output.retain).toBe(true);
    expect((await restored.receiptFor("semantic"))?.provenance).toEqual(provenance);
  });
});

describe("historical Curator Session upgrade", () => {
  async function fixture() {
    const pragmaHome = await home();
    const path = new PragmaPaths({ pragmaHome }).memoryExtractionSessions();
    await mkdir(dirname(path), { recursive: true });
    await copyFile(new URL("./fixtures/curator-sessions/v1.sqlite", import.meta.url), path);
    return { pragmaHome, path, store: createMemoryExtractionSessionStore({ pragmaHome }) };
  }
  it("upgrades real v1 staged work, receipts and Mission links; current reads are no-ops", async () => {
    const { path, store } = await fixture();
    const complete = await store.forMission("11111111-1111-4111-a111-111111111111");
    expect((await complete?.receiptFor("semantic"))?.output.retain).toBe(true);
    const staged = await store.forMission("22222222-2222-4222-a222-222222222222");
    expect(await staged?.call("find_existing_memory", {})).toContain("Staged");
    await staged?.call("finish_extraction", { retain: true });
    expect((await store.recover("semantic", "staged", "historical"))?.output.retain).toBe(true);
    await stat(`${path}.v1.backup`);
    const before = await readFile(path);
    await store.forMission("11111111-1111-4111-a111-111111111111");
    expect(await readFile(path)).toEqual(before);
  });
  it("rolls back interrupted upgrades and replays without losing the original", async () => {
    const { path, store } = await fixture();
    let db = new DatabaseSync(path);
    db.exec(
      "CREATE TRIGGER interrupt_upgrade BEFORE UPDATE ON sessions BEGIN SELECT RAISE(ABORT, 'injected-upgrade-failure'); END",
    );
    db.close();
    await expect(store.forMission("11111111-1111-4111-a111-111111111111")).rejects.toThrow(
      "injected-upgrade-failure",
    );
    db = new DatabaseSync(path);
    expect(db.prepare("PRAGMA user_version").get()).toMatchObject({ user_version: 1 });
    db.exec("DROP TRIGGER interrupt_upgrade");
    db.close();
    expect(
      (await (await store.forMission("11111111-1111-4111-a111-111111111111"))?.receipt())?.output
        .retain,
    ).toBe(true);
    db = new DatabaseSync(path);
    db.exec("PRAGMA user_version=99");
    db.close();
    await expect(store.forMission("11111111-1111-4111-a111-111111111111")).rejects.toThrow(
      "version_unsupported",
    );
  });
});
