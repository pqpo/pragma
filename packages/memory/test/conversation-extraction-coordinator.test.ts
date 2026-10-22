import { CONVERSATION_EXTRACTION_DELAYS } from "../src/pipeline/conversation-extraction-schedule.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
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

async function fixture(options: { onProjectionChanged?: () => Promise<void> } = {}) {
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
    onProjectionChanged: options.onProjectionChanged,
  });
  const semantic = await createSemanticMemoryModule({
    pragmaHome,
    now,
    extractionSettings,
    extractor,
    onProjectionChanged: options.onProjectionChanged,
  });
  const modules = { episodic, semantic };
  let closed = false;
  const seed = async (
    id: string,
    semanticDelay = 0,
    registerSubjects = true,
    completedAgo = CONVERSATION_EXTRACTION_DELAYS.completedMs,
  ) => {
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
        now: new Date(clock.getTime() - completedAgo + (type === "semantic" ? semanticDelay : 0)),
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
      if (closed) return;
      closed = true;
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
    ).toMatchObject({ status: "waiting_idle", attempts: 0 });
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

it("lets a competing process skip a live admission without waiting for its model turn", async () => {
  const f = await fixture();
  await f.seed("multi-host");
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      fileURLToPath(new URL("./support/conversation-coordinator-process.ts", import.meta.url)),
      f.pragmaHome,
    ],
    { stdio: ["ignore", "ignore", "pipe", "ipc"] },
  );
  let diagnostics = "";
  child.stderr!.on("data", (chunk) => {
    diagnostics += String(chunk);
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("message", () => resolve());
      child.once("exit", () => reject(new Error(diagnostics)));
    });
    const before = await f.modules.episodic.store.listExtractionJobs();
    const extract = vi.fn(async () => {
      throw new Error("duplicate model admission");
    });
    const competitor = createConversationMemoryExtractionCoordinator({
      pragmaHome: f.pragmaHome,
      now: f.now,
      ...f.modules,
    });
    competitor.setExtractor({ extract });
    const started = performance.now();
    await expect(competitor.runOnce()).resolves.toBeUndefined();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(extract).not.toHaveBeenCalled();
    expect(await f.modules.episodic.store.listExtractionJobs()).toEqual(before);
  } finally {
    if (child.connected) child.send("release");
    expect(await exited, diagnostics).toBe(0);
    f.close();
  }
}, 20_000);

it("renews a live claim without changing its fence and refuses stale lease renewal", async () => {
  const f = await fixture();
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  let finish: (() => void) | undefined;
  let running: Promise<void> | undefined;
  try {
    await f.seed("renewal");
    let admitted!: () => void;
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const coordinator = createConversationMemoryExtractionCoordinator({
      pragmaHome: f.pragmaHome,
      now: f.now,
      ...f.modules,
    });
    coordinator.setExtractor({
      async extract(batch) {
        batch.episodic!.options?.onAdmission?.();
        batch.semantic!.options?.onAdmission?.();
        admitted();
        await gate;
        await batch.episodic!.settle({
          output: { retain: false, reason: "low-value" },
          provenance,
        });
        await batch.semantic!.settle({
          output: { retain: false, reason: "no-stable-fact" },
          provenance,
        });
      },
    });
    running = coordinator.runOnce();
    await ready;
    const before = (await f.modules.episodic.store.listExtractionJobs())[0]!;
    f.advance(6 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    const renewed = (await f.modules.episodic.store.listExtractionJobs())[0]!;
    expect(renewed.revision).toBe(before.revision);
    expect(renewed.leaseUntil! > f.now().toISOString()).toBe(true);
    expect(await f.modules.episodic.store.claimDueJob(f.now())).toBeUndefined();
    finish!();
    await running;
    const completed = (await f.modules.episodic.store.listExtractionJobs())[0]!;
    await f.modules.episodic.store.renewClaimLease(before, f.now());
    expect((await f.modules.episodic.store.listExtractionJobs())[0]).toEqual(completed);
  } finally {
    finish?.();
    await running;
    vi.useRealTimers();
    f.close();
  }
});

it("preserves the completion grace period across repeated notifications and restart, then admits both types", async () => {
  const f = await fixture();
  const conversationRef = { type: "pragma.execution", id: "completion-grace" };
  let modules = f.modules;
  try {
    await f.seed(conversationRef.id, 0, true, 0);
    const deadline = new Date(
      f.now().getTime() + CONVERSATION_EXTRACTION_DELAYS.completedMs,
    ).toISOString();
    const extract = vi.fn(async (batch: import("../src/index.ts").ConversationExtractionBatch) => {
      await batch.episodic!.settle({ output: { retain: false, reason: "low-value" }, provenance });
      await batch.semantic!.settle({
        output: { retain: false, reason: "no-stable-fact" },
        provenance,
      });
    });
    const coordinatorFor = () => {
      const coordinator = createConversationMemoryExtractionCoordinator({
        pragmaHome: f.pragmaHome,
        now: f.now,
        ...modules,
      });
      coordinator.setExtractor({ extract });
      return coordinator;
    };
    await coordinatorFor().runOnce();
    expect(extract).not.toHaveBeenCalled();
    f.advance(CONVERSATION_EXTRACTION_DELAYS.completedMs - 1);
    for (const module of Object.values(modules)) {
      await module.setConversationState({ conversationRef, state: "completed", now: f.now() });
      expect((await module.store.listExtractionJobs())[0]).toMatchObject({
        status: "waiting_idle",
        eligibleAt: deadline,
        retryAt: deadline,
        attempts: 0,
      });
    }
    f.close();
    const unexpected = {
      extract: vi.fn(async () => {
        throw new Error("unexpected individual extraction");
      }),
    };
    modules = {
      episodic: await createEpisodicMemoryModule({
        pragmaHome: f.pragmaHome,
        now: f.now,
        extractor: unexpected,
      }),
      semantic: await createSemanticMemoryModule({
        pragmaHome: f.pragmaHome,
        now: f.now,
        extractor: unexpected,
      }),
    };
    for (const module of Object.values(modules)) {
      await module.setConversationState({ conversationRef, state: "completed", now: f.now() });
      expect((await module.store.listExtractionJobs())[0]?.eligibleAt).toBe(deadline);
    }
    const resumed = coordinatorFor();
    await resumed.runOnce();
    expect(extract).not.toHaveBeenCalled();
    f.advance(1);
    await resumed.runOnce();
    expect(extract).toHaveBeenCalledOnce();
    for (const module of Object.values(modules)) {
      expect((await module.store.listExtractionJobs())[0]).toMatchObject({
        status: "completed",
        completion: "rejected",
      });
    }
  } finally {
    modules.episodic.close();
    modules.semantic.close();
  }
});

it("deleting a completed Mission during the grace period prevents extraction, including replay after restart", async () => {
  const f = await fixture();
  const id = "deleted-during-grace";
  try {
    await f.seed(id, 0, true, 0);
    const replay = await f.modules.episodic.store.readEvidence(id);
    f.advance(CONVERSATION_EXTRACTION_DELAYS.completedMs - 1);
    for (const module of Object.values(f.modules))
      await module.store.deleteExecutionState([id], f.now());
    f.close();
    const unexpected = {
      extract: vi.fn(async () => {
        throw new Error("deleted Mission must not extract");
      }),
    };
    const modules = {
      episodic: await createEpisodicMemoryModule({
        pragmaHome: f.pragmaHome,
        now: f.now,
        extractor: unexpected,
      }),
      semantic: await createSemanticMemoryModule({
        pragmaHome: f.pragmaHome,
        now: f.now,
        extractor: unexpected,
      }),
    };
    try {
      f.advance(CONVERSATION_EXTRACTION_DELAYS.completedMs);
      for (const module of Object.values(modules)) {
        await module.consume(replay);
        await module.runBackgroundOnce?.();
        expect(await module.store.listExtractionJobs()).toEqual([]);
        expect(await module.store.readEvidence(id)).toEqual([]);
      }
      expect(unexpected.extract).not.toHaveBeenCalled();
    } finally {
      modules.episodic.close();
      modules.semantic.close();
    }
  } finally {
    f.close();
  }
});

it("starts the grace period from late terminal evidence and restores the idle threshold when reopened", async () => {
  const f = await fixture();
  try {
    const id = "late-terminal";
    const conversationRef = { type: "pragma.mission", id };
    for (const module of Object.values(f.modules))
      await module.setConversationState({ conversationRef, state: "completed", now: f.now() });
    f.advance(CONVERSATION_EXTRACTION_DELAYS.completedMs);
    const message = extractionInput().evidence[0]!;
    for (const module of Object.values(f.modules)) {
      await module.consume([
        {
          ...message,
          messageId: `${id}-terminal`,
          correlationId: id,
          conversationRef,
          occurredAt: f.now().toISOString(),
          topic: "execution.execution.terminal",
          schemaRef: "pragma.memory.execution-terminal/v2",
          payload: { outcome: "succeeded" },
        },
      ]);
      expect(await module.store.peekDueJob(f.now())).toBeUndefined();
      expect((await module.store.listExtractionJobs())[0]?.eligibleAt).toBe(
        new Date(f.now().getTime() + CONVERSATION_EXTRACTION_DELAYS.completedMs).toISOString(),
      );
      await module.setConversationState({ conversationRef, state: "active", now: f.now() });
      const deadline = new Date(f.now().getTime() + CONVERSATION_EXTRACTION_DELAYS.idleMs);
      expect((await module.store.listExtractionJobs())[0]?.eligibleAt).toBe(deadline.toISOString());
      expect(await module.store.peekDueJob(new Date(deadline.getTime() - 1))).toBeUndefined();
      expect(await module.store.peekDueJob(deadline)).toBeDefined();
    }
  } finally {
    f.close();
  }
});

it.each(["episodic", "semantic"] as const)(
  "%s does not shorten the grace period when completion predates the latest source evidence",
  async (type) => {
    const f = await fixture();
    try {
      const module = f.modules[type];
      const conversationRef = { type: "pragma.mission", id: "clock-rollback" };
      const sourceTime = new Date(f.now().getTime() + 120_000);
      const message = extractionInput().evidence[0]!;
      await module.consume([
        {
          ...message,
          conversationRef,
          occurredAt: sourceTime.toISOString(),
          messageId: "rollback-terminal",
          topic: "execution.execution.terminal",
          schemaRef: "pragma.memory.execution-terminal/v2",
          payload: { outcome: "succeeded" },
        },
      ]);
      await module.setConversationState({ conversationRef, state: "completed", now: f.now() });
      const expected = new Date(sourceTime.getTime() + CONVERSATION_EXTRACTION_DELAYS.completedMs);
      expect((await module.store.listExtractionJobs())[0]).toMatchObject({
        eligibleAt: expected.toISOString(),
        retryAt: expected.toISOString(),
        attempts: 0,
      });
      expect(await module.store.peekDueJob(new Date(expected.getTime() - 1))).toBeUndefined();
      expect(await module.store.peekDueJob(expected)).toBeDefined();
    } finally {
      f.close();
    }
  },
);

it("continues paired extraction when a companion projection notification is failing and in backoff", async () => {
  const notify = vi.fn(async (): Promise<void> => {
    throw new Error("learning delivery unavailable");
  });
  const f = await fixture({ onProjectionChanged: notify });
  const extract = vi.fn(async (batch: import("../src/index.ts").ConversationExtractionBatch) => {
    await batch.episodic!.settle({ output: { retain: false, reason: "low-value" }, provenance });
    const input = batch.semantic!.input;
    await batch.semantic!.settle({
      output: {
        retain: true,
        facts: [
          {
            statement: "The user prefers concise answers.",
            subjectRefs: input.allowedSubjectRefs.filter((ref) => ref.type === "pragma.user"),
            predicate: "user.preference.style",
            normalizedValue: "concise",
            conflictMode: "compatible",
            confidence: 0.9,
            evidenceRefs: [input.evidence[0]!.messageId],
          },
        ],
      },
      provenance,
    });
  });
  const coordinator = createConversationMemoryExtractionCoordinator({
    pragmaHome: f.pragmaHome,
    now: f.now,
    ...f.modules,
  });
  coordinator.setExtractor({ extract });
  try {
    await f.seed("before-notification-failure");
    await coordinator.runOnce();
    await expect(f.modules.semantic.runMaintenanceOnce?.()).rejects.toMatchObject({
      code: "memory_learning_notification_delivery_failed",
    });
    await f.seed("during-notification-failure");
    await coordinator.runOnce();
    expect(extract).toHaveBeenCalledTimes(2);
    for (const module of Object.values(f.modules))
      expect(
        (await module.store.listExtractionJobs()).every((job) => job.status === "completed"),
      ).toBe(true);
    expect(await f.modules.semantic.store.readProjectionNotification()).toBeDefined();
    notify.mockResolvedValue(undefined);
    f.advance(5000);
    await f.modules.semantic.runMaintenanceOnce?.();
    await f.modules.semantic.runMaintenanceOnce?.();
    expect(await f.modules.semantic.store.readProjectionNotification()).toBeUndefined();
    expect(extract).toHaveBeenCalledTimes(2);
  } finally {
    f.close();
  }
});
