import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PragmaPaths } from "@pragma/core";
import {
  MemoryEvidenceEnvelopeSchema,
  type MemoryEvidenceEnvelope,
  type MemorySubjectRef,
} from "@pragma/shared";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createEpisodicMemoryModule,
  createFederatedMemoryContextStore,
  MemoryModuleRegistry,
  type EpisodicExtractionInput,
  type EpisodicMemoryExtractor,
  type MemoryRecallScope,
} from "../src/index.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { recursive: true, force: true })),
  );
});

describe("Episodic Memory", () => {
  it("extracts a layered, evidence-traceable episode without WorkingState", async () => {
    const root = await temporaryRoot();
    const now = new Date("2026-08-03T12:00:00.000Z");
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor,
      now: () => now,
    });
    const evidence = executionEvidence("execution-a");

    await module.consume(evidence);
    await module.runBackgroundOnce?.();

    const episodes = await module.store.list();
    expect(episodes).toHaveLength(1);
    expect(episodes[0]).toMatchObject({
      executionId: "execution-a",
      revision: 1,
      language: "zh-Hans",
      outcome: { status: "succeeded" },
    });
    expect(extractor.extract).toHaveBeenCalledOnce();
    expect((await module.store.listExtractionJobs())[0]?.completedAt).toBe(now.toISOString());
    const readEvidence = vi.spyOn(module.store, "readEvidence");
    const getEvidence = vi.spyOn(module.store, "getEvidenceForRecall");

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const context = createFederatedMemoryContextStore(registry, {
      resolveRecallScope: () => expertScope("expert-a"),
    });
    const listed = await context.listContext({});
    expect(listed.ok && listed.value.map((item) => item.id)).toEqual([
      "catalog.md",
      "episodic/index.md",
      "episodic/summary.md",
      "guide.md",
      "overview.md",
    ]);
    const overview = await context.readContext({ id: "overview.md" });
    expect(overview.ok && overview.value.content).toContain("Episodic Memory Summary");
    const detail = await context.readContext({ id: `episodic/items/${episodes[0]!.id}.md` });
    expect(detail.ok && detail.value.content).toContain("## Evidence");
    expect(readEvidence).not.toHaveBeenCalled();
    expect(getEvidence).not.toHaveBeenCalled();
    await expect(
      context.readContext({ id: `episodic/evidence/${evidence[0]!.messageId}.md` }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_not_found" } });
    const evidenceDetail = await context.readContext({
      id: `episodic/evidence/${evidence.at(-1)!.messageId}.md`,
    });
    expect(evidenceDetail.ok && evidenceDetail.value.content).toContain("succeeded");
    expect(getEvidence).toHaveBeenCalledTimes(2);
    const search = await context.searchContext({ query: evidence[0]!.messageId });
    expect(search.ok && search.value.some((match) => match.id.includes("/evidence/"))).toBe(false);
    module.close();
  });

  it("fails closed when recall is disabled for the current asset", async () => {
    const registry = new MemoryModuleRegistry();
    const module = await createEpisodicMemoryModule({ pragmaHome: await temporaryRoot() });
    registry.register(module);
    const context = createFederatedMemoryContextStore(registry, {
      resolveRecallScope: (runContext) =>
        runContext?.source?.id === undefined || runContext.source.id === "blocked-expert"
          ? undefined
          : expertScope("expert-a"),
    });
    const runContext = { source: { type: "pragma.expert", id: "blocked-expert" } };

    await expect(context.listContext({ context: runContext })).resolves.toEqual({
      ok: true,
      value: [],
    });
    await expect(
      context.readContext({ id: "overview.md", context: runContext }),
    ).resolves.toMatchObject({ ok: false, error: { code: "permission_denied" } });
    await expect(context.listContext({})).resolves.toEqual({ ok: true, value: [] });
    await expect(context.searchContext({ query: "anything" })).resolves.toMatchObject({
      ok: false,
      error: { code: "permission_denied" },
    });
    module.close();
  });

  it("isolates personal stores while combining the current Team or Flow store with the current Expert", async () => {
    const root = await temporaryRoot();
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
    });
    const cases = [
      {
        executionId: "personal-a",
        rootRef: ref("pragma.expert", "expert-a"),
        producerRefs: [ref("pragma.expert", "expert-a")],
      },
      {
        executionId: "personal-b",
        rootRef: ref("pragma.expert", "expert-b"),
        producerRefs: [ref("pragma.expert", "expert-b")],
      },
      {
        executionId: "team-a",
        rootRef: ref("pragma.expert-team", "team-t"),
        producerRefs: [ref("pragma.expert", "expert-a")],
      },
      {
        executionId: "flow-a",
        rootRef: ref("pragma.flow", "flow-f"),
        producerRefs: [ref("pragma.expert", "expert-a")],
      },
    ];
    for (const item of cases) {
      await module.consume(executionEvidence(item.executionId, item.rootRef, item.producerRefs));
      await module.runBackgroundOnce?.();
    }
    const records = await module.store.list();
    const byExecution = new Map(records.map((record) => [record.executionId, record]));
    expect(byExecution.get("team-a")).toMatchObject({
      rootRefs: [{ type: "pragma.expert-team", id: "team-t" }],
      producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
      bindings: [
        {
          consumerRef: { type: "pragma.expert-team", id: "team-t" },
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
    });

    const registry = new MemoryModuleRegistry();
    registry.register(module);
    const personalA = scopedContext(registry, expertScope("expert-a"));
    const personalIndex = await personalA.readContext({ id: "episodic/index.md" });
    expect(personalIndex.ok && personalIndex.value.content).toContain("personal-a");
    expect(personalIndex.ok && personalIndex.value.content).not.toMatch(/personal-b|team-a|flow-a/);

    const teamA = scopedContext(registry, {
      rootRef: ref("pragma.expert-team", "team-t"),
      expertRef: ref("pragma.expert", "expert-a"),
    });
    const teamIndex = await teamA.readContext({ id: "episodic/index.md" });
    expect(teamIndex.ok && teamIndex.value.content).toMatch(/team-a[\s\S]*personal-a/);
    expect(teamIndex.ok && teamIndex.value.content).not.toMatch(/personal-b|flow-a/);
    expect(teamIndex.ok && teamIndex.value.content).toContain("[current-asset]");
    expect(teamIndex.ok && teamIndex.value.content).toContain("[personal]");

    const foreign = byExecution.get("personal-b")!;
    await expect(
      teamA.readContext({ id: `episodic/items/${foreign.id}.md` }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_not_found" } });
    const foreignEvidence = executionEvidence("personal-b", ref("pragma.expert", "expert-b"), [
      ref("pragma.expert", "expert-b"),
    ])[0]!;
    await expect(
      teamA.readContext({ id: `episodic/evidence/${foreignEvidence.messageId}.md` }),
    ).resolves.toMatchObject({ ok: false, error: { code: "context_not_found" } });
    await expect(teamA.searchContext({ query: "personal-b" })).resolves.toMatchObject({
      ok: true,
      value: [],
    });

    const flowA = scopedContext(registry, {
      rootRef: ref("pragma.flow", "flow-f"),
      expertRef: ref("pragma.expert", "expert-a"),
    });
    const flowIndex = await flowA.readContext({ id: "episodic/index.md" });
    expect(flowIndex.ok && flowIndex.value.content).toMatch(/flow-a[\s\S]*personal-a/);
    expect(flowIndex.ok && flowIndex.value.content).not.toMatch(/personal-b|team-a/);
    module.close();
  });

  it("is idempotent on replay and revises the same episode for a later terminal event", async () => {
    const root = await temporaryRoot();
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({ pragmaHome: root, extractor });
    const evidence = executionEvidence("execution-b");
    await module.consume(evidence);
    await module.runBackgroundOnce?.();
    simulateJobCompletionCrash(root);
    await module.runBackgroundOnce?.();
    expect((await module.store.list())[0]?.revision).toBe(1);
    expect(extractor.extract).toHaveBeenCalledTimes(1);

    await module.consume(evidence);
    await module.runBackgroundOnce?.();
    expect((await module.store.list())[0]?.revision).toBe(1);
    expect(extractor.extract).toHaveBeenCalledTimes(1);

    const later = terminalEvidence("execution-b", "terminal-later", "2026-08-01T01:00:00.000Z");
    await module.consume([later]);
    await module.runBackgroundOnce?.();
    expect((await module.store.list())[0]?.revision).toBe(2);
    expect(extractor.extract).toHaveBeenCalledTimes(2);
    module.close();
  });

  it("only tightens recall permissions and forgets content without allowing replay to recreate it", async () => {
    const root = await temporaryRoot();
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor: fakeExtractor(),
    });
    const evidence = executionEvidence("execution-governance");
    await module.consume(evidence);
    await module.runBackgroundOnce?.();
    const initial = (await module.store.list())[0]!;
    const actorRef = ref("pragma.user", "local-user");
    const tightened = await module.store.tightenAccess({
      id: initial.id,
      expectedRevision: initial.revision,
      actorRef,
      reason: "Keep this episode out of recall.",
      bindings: initial.bindings.map((binding) => ({
        ...binding,
        recall: "deny" as const,
        permissionRevision: binding.permissionRevision + 1,
      })),
      now: new Date("2026-08-03T12:00:00.000Z"),
    });
    await expect(
      module.store.tightenAccess({
        id: tightened.id,
        expectedRevision: tightened.revision,
        actorRef,
        reason: "Attempt to expand recall.",
        bindings: tightened.bindings.map((binding) => ({
          ...binding,
          recall: "allow" as const,
          permissionRevision: binding.permissionRevision + 1,
        })),
        now: new Date("2026-08-03T12:01:00.000Z"),
      }),
    ).rejects.toThrow("memory_permission_expansion_denied");
    expect(await module.store.listForRecall(expertScope("expert-a"))).toEqual([]);
    expect(await module.store.history(initial.id)).toHaveLength(2);
    expect(await module.store.getEvidence(evidence.at(-1)!.messageId)).toBeDefined();

    await expect(
      module.store.forget({
        id: tightened.id,
        expectedRevision: tightened.revision,
        actorRef: null as unknown as MemorySubjectRef,
        reason: "Malformed governance actor.",
        now: new Date("2026-08-03T12:01:30.000Z"),
      }),
    ).rejects.toThrow();
    expect(await module.store.get(initial.id)).toBeDefined();

    await module.store.forget({
      id: tightened.id,
      expectedRevision: tightened.revision,
      actorRef,
      reason: "User requested forgetting.",
      now: new Date("2026-08-03T12:02:00.000Z"),
    });
    expect(await module.store.get(initial.id)).toBeUndefined();
    expect(await module.store.history(initial.id)).toEqual([]);
    expect(await module.store.getEvidence(evidence.at(-1)!.messageId)).toBeUndefined();

    await module.consume([
      terminalEvidence("execution-governance", "terminal-after-forget", "2026-08-03T12:03:00.000Z"),
    ]);
    await module.runBackgroundOnce?.();
    expect(await module.store.list()).toEqual([]);
    module.close();

    const database = new DatabaseSync(
      join(
        new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot("pragma.memory.episodic"),
        "episodes.sqlite",
      ),
    );
    const tombstone = database
      .prepare("SELECT tombstone_json AS value FROM tombstones WHERE id = ?")
      .get(initial.id) as { readonly value: string };
    const governance = database
      .prepare("SELECT COUNT(*) AS count FROM governance_events WHERE episode_id = ?")
      .get(initial.id) as { readonly count: number };
    database.close();
    expect(governance.count).toBe(0);
    expect(tombstone.value).not.toMatch(
      /Repair|goal|summary|evidenceRefs|Keep this episode|User requested forgetting/,
    );
  });

  it("upgrades a historical episodic v1 database to revision bindings", async () => {
    const root = await temporaryRoot();
    const dataRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleDataRoot(
      "pragma.memory.episodic",
    );
    await mkdir(dataRoot, { recursive: true });
    const database = new DatabaseSync(join(dataRoot, "episodes.sqlite"));
    database.exec(`
      CREATE TABLE episodes (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        revision INTEGER NOT NULL,
        status TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const historical = JSON.parse(
      await readFile(new URL("./fixtures/episodic-v1-record.json", import.meta.url), "utf8"),
    ) as Record<string, unknown>;
    database
      .prepare(
        "INSERT INTO episodes(id, execution_id, revision, status, updated_at, record_json) VALUES (?, ?, ?, ?, ?, ?)",
      )
      .run(
        historical["id"] as string,
        historical["executionId"] as string,
        historical["revision"] as number,
        historical["status"] as string,
        historical["updatedAt"] as string,
        JSON.stringify(historical),
      );
    database.close();

    const module = await createEpisodicMemoryModule({ pragmaHome: root });
    expect((await module.store.list())[0]).toMatchObject({
      schemaVersion: "pragma.memory-episodic/v2",
      bindings: [
        {
          consumerRef: { type: "pragma.expert", id: "expert-a" },
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
    });
    const backup = new DatabaseSync(join(dataRoot, "episodes.sqlite.v1.backup"));
    expect(
      (backup.prepare("PRAGMA user_version").get() as unknown as { readonly user_version: number })
        .user_version,
    ).toBe(1);
    backup.close();
    module.close();
  });

  it("rejects low-value and restricted evidence without invoking the model", async () => {
    for (const sensitivity of ["confidential", "restricted"] as const) {
      const root = await temporaryRoot();
      const extractor = fakeExtractor();
      const module = await createEpisodicMemoryModule({ pragmaHome: root, extractor });
      const short = [
        messageEvidence("short", "short-user", "user", "hi", sensitivity),
        terminalEvidence(
          "short",
          `short-terminal-${sensitivity}`,
          "2026-08-01T00:00:01.000Z",
          sensitivity,
        ),
      ];
      await module.consume(short);
      await module.runBackgroundOnce?.();
      expect(extractor.extract).not.toHaveBeenCalled();
      expect(await module.store.list()).toEqual([]);
      const diagnostic = await module.store.inspect();
      expect(diagnostic.rejected).toBe(1);
      expect(
        diagnostic.rejectedByReason[sensitivity === "restricted" ? "sensitive" : "low-value"],
      ).toBe(1);
      module.close();
    }
  });

  it("rejects incompatible restricted visibility before invoking the model", async () => {
    const root = await temporaryRoot();
    const extractor = fakeExtractor();
    const module = await createEpisodicMemoryModule({ pragmaHome: root, extractor });
    const evidence = executionEvidence("visibility-conflict").map((item, index) =>
      MemoryEvidenceEnvelopeSchema.parse({
        ...item,
        visibility: {
          mode: "restricted",
          principals: [ref("pragma.expert", index === 1 ? "expert-b" : "expert-a")],
        },
      }),
    );

    await module.consume(evidence);
    await module.runBackgroundOnce?.();

    expect(extractor.extract).not.toHaveBeenCalled();
    expect(await module.store.list()).toEqual([]);
    expect(await module.store.inspect()).toMatchObject({
      rejected: 1,
      rejectedByReason: { policy: 1 },
      needsAttention: 0,
    });
    module.close();
  });

  it("moves repeated invalid Evidence references to needs_attention without dropping the job", async () => {
    const root = await temporaryRoot();
    let clock = new Date("2026-08-01T00:00:00.000Z");
    const extractor = fakeExtractor("unknown-evidence-id");
    const module = await createEpisodicMemoryModule({
      pragmaHome: root,
      extractor,
      now: () => clock,
    });
    await module.consume(executionEvidence("execution-c"));
    await module.runBackgroundOnce?.();
    clock = new Date(clock.getTime() + 61_000);
    await module.runBackgroundOnce?.();
    clock = new Date(clock.getTime() + 5 * 60_000 + 1_000);
    await module.runBackgroundOnce?.();
    const diagnostic = await module.store.inspect();
    expect(diagnostic.needsAttention).toBe(1);
    expect(await module.store.list()).toEqual([]);
    module.close();
  });

  it("reads legacy Evidence attribution conservatively and rejects conflicting roots", async () => {
    const legacyRoot = await temporaryRoot();
    const legacy = await createEpisodicMemoryModule({
      pragmaHome: legacyRoot,
      extractor: fakeExtractor(),
    });
    const withoutAttribution = executionEvidence("legacy-attribution").map((item) =>
      MemoryEvidenceEnvelopeSchema.parse({ ...item, attribution: undefined }),
    );
    await legacy.consume(withoutAttribution);
    await legacy.runBackgroundOnce?.();
    expect((await legacy.store.list())[0]).toMatchObject({
      rootRefs: [{ type: "pragma.expert", id: "expert-a" }],
      bindings: [
        {
          consumerRef: { type: "pragma.expert", id: "expert-a" },
          recall: "allow",
          export: "deny",
          permissionRevision: 1,
        },
      ],
    });

    const legacyTeam = executionEvidence(
      "legacy-team-attribution",
      ref("pragma.expert-team", "team-a"),
      [ref("pragma.expert", "expert-a")],
    ).map((item) =>
      MemoryEvidenceEnvelopeSchema.parse({
        ...item,
        attribution: undefined,
        bindings: [...item.bindings].reverse(),
      }),
    );
    await legacy.consume(legacyTeam);
    await legacy.runBackgroundOnce?.();
    expect(
      (await legacy.store.list()).find(
        (episode) => episode.executionId === "legacy-team-attribution",
      ),
    ).toMatchObject({
      rootRefs: [{ type: "pragma.expert-team", id: "team-a" }],
      producerRefs: [{ type: "pragma.expert", id: "expert-a" }],
    });
    legacy.close();

    const conflictRoot = await temporaryRoot();
    let clock = new Date("2026-08-01T00:00:00.000Z");
    const conflict = await createEpisodicMemoryModule({
      pragmaHome: conflictRoot,
      extractor: fakeExtractor(),
      now: () => clock,
    });
    const mismatched = executionEvidence("conflicting-attribution");
    mismatched[mismatched.length - 1] = terminalEvidence(
      "conflicting-attribution",
      "conflicting-attribution-terminal",
      "2026-08-01T00:00:02.000Z",
      "confidential",
      ref("pragma.flow", "foreign-flow"),
      [ref("pragma.expert", "expert-a")],
    );
    await conflict.consume(mismatched);
    for (const advance of [0, 61_000, 5 * 60_000 + 1_000]) {
      clock = new Date(clock.getTime() + advance);
      await conflict.runBackgroundOnce?.();
    }
    expect(await conflict.store.list()).toEqual([]);
    expect((await conflict.store.inspect()).needsAttention).toBe(1);
    conflict.close();
  });

  it("expires failed payloads after 30 days without startup-style retry", async () => {
    const module = await createEpisodicMemoryModule({ pragmaHome: await temporaryRoot() });
    await module.consume(executionEvidence("expiry"));
    const job = await module.store.claimDueJob(new Date("2026-08-01T00:00:03.000Z"));
    expect(job).toBeDefined();
    await module.store.fail({
      job: job!,
      errorCode: "memory_extractor_profile_invalid",
      now: new Date("2026-08-01T00:00:04.000Z"),
      retry: "configuration",
    });

    await module.store.maintain(new Date("2026-09-01T00:00:05.000Z"));
    const [expired] = await module.store.listExtractionJobs();
    expect(expired).toMatchObject({ status: "expired", failureClass: "configuration" });
    expect(await module.store.readEvidence("expiry")).toEqual([]);
    await expect(
      module.store.retryJob({
        id: expired!.id,
        expectedRevision: expired!.revision,
        now: new Date(),
      }),
    ).rejects.toThrow("memory_extraction_job_not_retryable");
    module.close();
  });

  it("does not recreate transient state or long-term memory after an Execution is deleted", async () => {
    const module = await createEpisodicMemoryModule({
      pragmaHome: await temporaryRoot(),
      extractor: fakeExtractor(),
    });
    const evidence = executionEvidence("deleted-execution");
    await module.consume(evidence);
    const claimed = await module.store.claimDueJob(new Date("2026-08-04T00:00:00.000Z"));
    expect(claimed).toBeDefined();
    await module.store.deleteExecutionState(["deleted-execution"]);
    await module.store.fail({
      job: claimed!,
      errorCode: "late_extractor_failure",
      now: new Date("2026-08-04T00:01:00.000Z"),
      retry: "transient",
    });

    await module.runBackgroundOnce?.();
    await module.consume(evidence);
    await module.runBackgroundOnce?.();

    expect(await module.store.readEvidence("deleted-execution")).toEqual([]);
    expect(await module.store.listExtractionJobs()).toEqual([]);
    expect(await module.store.list()).toEqual([]);
    module.close();
  });

  it("upgrades persisted extraction jobs from v1 to v2 on first access", async () => {
    const root = await temporaryRoot();
    const stateRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(
      "pragma.memory.episodic",
    );
    await mkdir(stateRoot, { recursive: true });
    const database = new DatabaseSync(join(stateRoot, "jobs.sqlite"));
    database.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        terminal_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_at TEXT,
        lease_until TEXT,
        job_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const legacyJob = {
      schemaVersion: "pragma.memory-extraction-job/v1",
      id: "legacy-job",
      executionId: "legacy-execution",
      terminalMessageId: "legacy-terminal",
      status: "needs_attention",
      attempts: 3,
      lastErrorCode: "legacy_failure",
      updatedAt: "2026-08-01T00:00:00.000Z",
    };
    database
      .prepare(
        `INSERT INTO jobs(id, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        legacyJob.id,
        legacyJob.executionId,
        legacyJob.terminalMessageId,
        legacyJob.status,
        JSON.stringify(legacyJob),
      );
    database.close();

    const module = await createEpisodicMemoryModule({ pragmaHome: root });
    await expect(module.store.listExtractionJobs()).resolves.toEqual([
      expect.objectContaining({
        schemaVersion: "pragma.memory-extraction-job/v2",
        id: "legacy-job",
        revision: 1,
        totalAttempts: 3,
        status: "needs_attention",
        failureClass: "transient-exhausted",
      }),
    ]);
    const backup = new DatabaseSync(join(stateRoot, "jobs.sqlite.v1.backup"));
    expect(
      (backup.prepare("PRAGMA user_version").get() as unknown as { readonly user_version: number })
        .user_version,
    ).toBe(1);
    backup.close();
    module.close();

    const future = new DatabaseSync(join(stateRoot, "jobs.sqlite"));
    future.exec("PRAGMA user_version = 3;");
    future.close();
    await expect(createEpisodicMemoryModule({ pragmaHome: root })).rejects.toThrow(
      "unsupported-state-version:pragma.memory-episodic-jobs/v3",
    );
  });

  it("fails closed when an unversioned episodic database already contains tables", async () => {
    const root = await temporaryRoot();
    const stateRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(
      "pragma.memory.episodic",
    );
    await mkdir(stateRoot, { recursive: true });
    const database = new DatabaseSync(join(stateRoot, "jobs.sqlite"));
    database.exec("CREATE TABLE jobs (id TEXT PRIMARY KEY);");
    database.close();

    await expect(createEpisodicMemoryModule({ pragmaHome: root })).rejects.toThrow(
      "corrupt-state-version:pragma.memory-episodic-jobs/v0-with-table:jobs",
    );
  });

  it("preserves v1 state and replays the migration after a malformed job is repaired", async () => {
    const root = await temporaryRoot();
    const stateRoot = new PragmaPaths({ pragmaHome: root }).memoryModuleStateRoot(
      "pragma.memory.episodic",
    );
    await mkdir(stateRoot, { recursive: true });
    const statePath = join(stateRoot, "jobs.sqlite");
    const database = new DatabaseSync(statePath);
    database.exec(`
      CREATE TABLE jobs (
        id TEXT PRIMARY KEY,
        execution_id TEXT NOT NULL UNIQUE,
        terminal_message_id TEXT NOT NULL,
        status TEXT NOT NULL,
        retry_at TEXT,
        lease_until TEXT,
        job_json TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    const malformed = {
      schemaVersion: "pragma.memory-extraction-job/v1",
      id: "repairable-job",
      executionId: "repairable-execution",
      terminalMessageId: "repairable-terminal",
      status: "pending",
      attempts: 0,
    };
    database
      .prepare(
        `INSERT INTO jobs(id, execution_id, terminal_message_id, status, retry_at, lease_until, job_json)
         VALUES (?, ?, ?, ?, NULL, NULL, ?)`,
      )
      .run(
        malformed.id,
        malformed.executionId,
        malformed.terminalMessageId,
        malformed.status,
        JSON.stringify(malformed),
      );
    database.close();

    await expect(createEpisodicMemoryModule({ pragmaHome: root })).rejects.toThrow();
    const preserved = new DatabaseSync(statePath);
    expect(
      (
        preserved.prepare("PRAGMA user_version").get() as unknown as {
          readonly user_version: number;
        }
      ).user_version,
    ).toBe(1);
    preserved
      .prepare("UPDATE jobs SET job_json = ? WHERE id = ?")
      .run(JSON.stringify({ ...malformed, updatedAt: "2026-08-01T00:00:00.000Z" }), malformed.id);
    preserved.close();

    const recovered = await createEpisodicMemoryModule({ pragmaHome: root });
    expect((await recovered.store.listExtractionJobs())[0]).toMatchObject({
      schemaVersion: "pragma.memory-extraction-job/v2",
      id: malformed.id,
    });
    recovered.close();
  });
});

function fakeExtractor(
  forcedRef?: string,
): EpisodicMemoryExtractor & { extract: ReturnType<typeof vi.fn> } {
  const extract = vi.fn(async (input: EpisodicExtractionInput) => {
    const ref = forcedRef ?? input.evidence.at(-1)!.messageId;
    return {
      output: {
        retain: true as const,
        language: "zh-Hans",
        goal: { text: "完成记忆架构实现", evidenceRefs: [ref] },
        summary: { text: `实现并验证了分层记忆 ${input.executionId}。`, evidenceRefs: [ref] },
        attempts: [{ description: "实现 Episodic 模块", result: "成功", evidenceRefs: [ref] }],
        failuresAndRecoveries: [],
        outcome: { status: "succeeded" as const, summary: "实现完成", evidenceRefs: [ref] },
        valueScore: 0.9,
      },
      provenance: {
        curatorRef: "expert:0000000000memory",
        promptVersion: "pragma.memory-curator/v1",
        profileRevision: 0,
        runtimeId: "test-runtime",
        providerId: "test-provider",
        modelId: "test-model",
        extractedAt: "2026-08-01T00:00:02.000Z",
      },
    };
  });
  return { extract };
}

function executionEvidence(
  executionId: string,
  rootRef: MemorySubjectRef = ref("pragma.expert", "expert-a"),
  producerRefs: readonly MemorySubjectRef[] = [ref("pragma.expert", "expert-a")],
): MemoryEvidenceEnvelope[] {
  return [
    messageEvidence(
      executionId,
      `${executionId}-user`,
      "user",
      "请实现分层 Episodic Memory，并完成消息总线、持久任务与测试。",
      "confidential",
      rootRef,
      producerRefs,
    ),
    messageEvidence(
      executionId,
      `${executionId}-assistant`,
      "assistant",
      "已经完成分层协议、Episodic Store、后台任务和 Context 投影。",
      "confidential",
      rootRef,
      producerRefs,
    ),
    terminalEvidence(
      executionId,
      `${executionId}-terminal`,
      "2026-08-01T00:00:02.000Z",
      "confidential",
      rootRef,
      producerRefs,
    ),
  ];
}

function messageEvidence(
  executionId: string,
  messageId: string,
  role: "user" | "assistant",
  text: string,
  sensitivity: "confidential" | "restricted" = "confidential",
  rootRef: MemorySubjectRef = ref("pragma.expert", "expert-a"),
  producerRefs: readonly MemorySubjectRef[] = [ref("pragma.expert", "expert-a")],
): MemoryEvidenceEnvelope {
  return envelope({
    executionId,
    messageId,
    topic: "execution.message.appended",
    schemaRef: "pragma.memory.execution-message/v2",
    sensitivity,
    payload: {
      message: role === "user" ? { role, text } : { role, text, stopReason: "stop" },
    },
    rootRef,
    producerRefs,
  });
}

function terminalEvidence(
  executionId: string,
  messageId: string,
  occurredAt: string,
  sensitivity: "confidential" | "restricted" = "confidential",
  rootRef: MemorySubjectRef = ref("pragma.expert", "expert-a"),
  producerRefs: readonly MemorySubjectRef[] = [ref("pragma.expert", "expert-a")],
): MemoryEvidenceEnvelope {
  return envelope({
    executionId,
    messageId,
    topic: "execution.execution.terminal",
    schemaRef: "pragma.memory.execution-terminal/v2",
    sensitivity,
    payload: { outcome: "succeeded" },
    occurredAt,
    rootRef,
    producerRefs,
  });
}

function envelope(input: {
  readonly executionId: string;
  readonly messageId: string;
  readonly topic: string;
  readonly schemaRef: string;
  readonly sensitivity: "confidential" | "restricted";
  readonly payload: unknown;
  readonly occurredAt?: string;
  readonly rootRef: MemorySubjectRef;
  readonly producerRefs: readonly MemorySubjectRef[];
}): MemoryEvidenceEnvelope {
  const consumers = uniqueRefs([input.rootRef, ...input.producerRefs]);
  return MemoryEvidenceEnvelopeSchema.parse({
    schemaVersion: "pragma.memory-evidence/v1",
    messageId: input.messageId,
    topic: input.topic,
    schemaRef: input.schemaRef,
    sourceRef: {
      type: "pragma.execution-event",
      id: input.messageId,
      canonicalEventId: `canonical-${input.messageId}`,
    },
    subjectRefs: [
      { type: "pragma.execution", id: input.executionId },
      input.rootRef,
      ...input.producerRefs,
    ],
    correlationId: input.executionId,
    occurredAt: input.occurredAt ?? "2026-08-01T00:00:00.000Z",
    visibility: { mode: "host-private" },
    sensitivity: input.sensitivity,
    bindings: consumers.map((consumerRef) => ({ consumerRef, access: "allow" })),
    attribution: { rootRef: input.rootRef, producerRefs: input.producerRefs },
    policySnapshot: {
      capture: true,
      recall: true,
      learning: "disabled",
      appliedRevisions: [],
    },
    payload: input.payload,
  });
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-episodic-"));
  roots.push(root);
  return root;
}

function expertScope(id: string) {
  return {
    rootRef: { type: "pragma.expert" as const, id },
    expertRef: { type: "pragma.expert" as const, id },
  };
}

function scopedContext(registry: MemoryModuleRegistry, scope: MemoryRecallScope) {
  return createFederatedMemoryContextStore(registry, { resolveRecallScope: () => scope });
}

function ref<TType extends string>(
  type: TType,
  id: string,
): { readonly type: TType; readonly id: string } {
  return { type, id };
}

function uniqueRefs(refs: readonly MemorySubjectRef[]): MemorySubjectRef[] {
  return [...new Map(refs.map((item) => [`${item.type}\0${item.id}`, item])).values()];
}

function simulateJobCompletionCrash(pragmaHome: string): void {
  const path = join(
    new PragmaPaths({ pragmaHome }).memoryModuleStateRoot("pragma.memory.episodic"),
    "jobs.sqlite",
  );
  const database = new DatabaseSync(path);
  database
    .prepare(
      "UPDATE jobs SET status = 'running', lease_until = '1970-01-01T00:00:00.000Z' WHERE status = 'completed'",
    )
    .run();
  database.close();
}
