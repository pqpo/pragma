import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  createConversationMemoryExtractionCoordinator,
  createEpisodicMemoryModule,
  createSemanticMemoryModule,
  createFileMemoryExtractionSettingsStore,
  createMemoryExtractionSessionStore,
  ConversationExtractionInputSchema,
} from "../src/index.ts";
import { extractionInput, provenance } from "./support/extraction.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-conversation-coordinator-"));
  roots.push(pragmaHome);
  let clock = new Date("2026-10-16T00:00:00.000Z");
  const now = () => clock;
  const extractionSettings = createFileMemoryExtractionSettingsStore({ pragmaHome, now });
  const extractor = {
    extract: vi.fn(async () => {
      throw new Error("unexpected model admission");
    }),
  };
  const episodic = await createEpisodicMemoryModule({
    pragmaHome,
    now,
    extractionSettings,
    extractor,
  });
  const semantic = await createSemanticMemoryModule({
    pragmaHome,
    now,
    extractionSettings,
    extractor,
  });
  const modules = { episodic, semantic };
  const seed = async (id: string, semanticDelay = 0, registerSubjects = true) => {
    const source = extractionInput(
      "Remember this lasting preference: always provide concise Simplified Chinese answers.",
    ).evidence[0]!;
    const message = {
      ...source,
      messageId: `${id}-message`,
      correlationId: id,
      subjectRefs: [{ type: "pragma.execution", id }],
      attribution: { rootRef: { type: "pragma.expert", id: "expert" }, producerRefs: [] },
    };
    if (registerSubjects)
      await semantic.registerExecutionSubjects({
        executionId: id,
        subjectRefs: [{ type: "pragma.user", id: "user" }],
      });
    for (const type of ["episodic", "semantic"] as const) {
      await modules[type].consume([
        message,
        {
          ...message,
          messageId: `${id}-terminal`,
          topic: "execution.execution.terminal",
          schemaRef: "pragma.memory.execution-terminal/v2",
          payload: { outcome: "succeeded" },
        },
      ]);
      await modules[type].setConversationState({
        conversationRef: { type: "pragma.execution", id },
        state: "completed",
        now: new Date(clock.getTime() + (type === "semantic" ? semanticDelay : 0)),
      });
    }
  };
  return {
    pragmaHome,
    now,
    modules,
    extractionSettings,
    seed,
    advance(ms: number) {
      clock = new Date(clock.getTime() + ms);
    },
    close() {
      episodic.close();
      semantic.close();
    },
  };
}

it("waits for the companion delivery without blocking another due conversation", async () => {
  const f = await fixture();
  try {
    await f.seed("delayed", 1000);
    await f.seed("ready");
    const extract = vi.fn(async (batch: import("../src/index.ts").ConversationExtractionBatch) => {
      expect(batch.episodic).toBeDefined();
      expect(batch.semantic).toBeDefined();
      await batch.episodic!.settle({ output: { retain: false, reason: "low-value" }, provenance });
      await batch.semantic!.settle({
        output: { retain: false, reason: "no-stable-fact" },
        provenance,
      });
    });
    const coordinator = createConversationMemoryExtractionCoordinator({
      pragmaHome: f.pragmaHome,
      now: f.now,
      ...f.modules,
    });
    coordinator.setExtractor({ extract });
    await coordinator.runOnce();
    expect(extract).toHaveBeenCalledOnce();
    expect(extract.mock.calls[0]![0].episodic!.input.executionId).toBe("ready");
    expect(
      (await f.modules.episodic.store.listExtractionJobs()).find(
        (job) => job.executionId === "delayed",
      ),
    ).toMatchObject({ status: "pending", attempts: 0 });
    f.advance(1000);
    await coordinator.runOnce();
    expect(extract).toHaveBeenCalledTimes(2);
    expect(extract.mock.calls[1]![0].episodic!.input.executionId).toBe("delayed");
  } finally {
    f.close();
  }
});

it("defers an unadmitted claim when its companion fails preparation, then retries both after repair", async () => {
  const f = await fixture();
  try {
    await f.seed("repair", 0, false);
    const extract = vi.fn(async (batch: import("../src/index.ts").ConversationExtractionBatch) => {
      expect(batch.episodic).toBeDefined();
      expect(batch.semantic).toBeDefined();
      await batch.episodic!.settle({ output: { retain: false, reason: "low-value" }, provenance });
      await batch.semantic!.settle({
        output: { retain: false, reason: "no-stable-fact" },
        provenance,
      });
    });
    const coordinator = createConversationMemoryExtractionCoordinator({
      pragmaHome: f.pragmaHome,
      now: f.now,
      ...f.modules,
    });
    coordinator.setExtractor({ extract });
    await coordinator.runOnce();
    expect(extract).not.toHaveBeenCalled();
    expect((await f.modules.episodic.store.listExtractionJobs())[0]).toMatchObject({
      status: "pending",
      attempts: 0,
      totalAttempts: 0,
    });
    await f.modules.semantic.registerExecutionSubjects({
      executionId: "repair",
      subjectRefs: [{ type: "pragma.user", id: "user" }],
    });
    f.advance(5000);
    await coordinator.runOnce();
    expect(extract).toHaveBeenCalledOnce();
  } finally {
    f.close();
  }
});

it("never revives a claim invalidated by new conversation activity when deferring it", async () => {
  const f = await fixture();
  try {
    await f.seed("changed");
    const work = await f.modules.episodic.prepareBackgroundOnce();
    await f.modules.episodic.setConversationState({
      conversationRef: { type: "pragma.execution", id: "changed" },
      state: "active",
      now: f.now(),
    });
    await work!.defer();
    expect((await f.modules.episodic.store.listExtractionJobs())[0]).toMatchObject({
      status: "waiting_idle",
      attempts: 0,
      totalAttempts: 0,
    });
  } finally {
    f.close();
  }
});

it.each(["episodic", "semantic"] as const)(
  "%s guards also recheck consent for the completed companion's Native context",
  async (type) => {
    const f = await fixture();
    let work:
      | Awaited<ReturnType<typeof f.modules.episodic.prepareBackgroundOnce>>
      | Awaited<ReturnType<typeof f.modules.semantic.prepareBackgroundOnce>>;
    try {
      await f.seed("consent");
      work = await f.modules[type].prepareBackgroundOnce();
      expect(work).toBeDefined();
      const companion = type === "episodic" ? "semantic" : "episodic";
      const source = work!.input.evidence[0]!;
      const privateContent = {
        ...source,
        messageId: "private",
        topic: "execution.tool.content",
        schemaRef: "pragma.memory.tool-content/v1",
        payload: {
          toolName: "lookup",
          phase: "completed",
          completeness: "full",
          text: "revoked private content",
          allowedModules: [companion],
        },
      };
      const input = ConversationExtractionInputSchema.parse({
        ...extractionInput(),
        schemaVersion: "pragma.memory-conversation-extraction-input/v1",
        targets: ["episodic", "semantic"],
        jobs: {
          episodic: { jobId: "e", watermark: "w" },
          semantic: { jobId: "s", watermark: "w" },
        },
        evidence: [source, privateContent],
        evidenceTypes: { [source.messageId]: [type], private: [companion] },
      });
      const session = await createMemoryExtractionSessionStore({ pragmaHome: f.pragmaHome }).create(
        { ...work!.options, module: "conversation", input, watermark: "w", activeTypes: [type] },
      );
      // This claim has only ordinary user text. Its own assertAccess cannot see the companion's
      // historical tool content, but resuming the original Native context must still check it.
      await expect(session.assertCurrent()).rejects.toThrow("tool_content_denied");
    } finally {
      await work?.fail(new Error("test cleanup"));
      f.close();
    }
  },
);
