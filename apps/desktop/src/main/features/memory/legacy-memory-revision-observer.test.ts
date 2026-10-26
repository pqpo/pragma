import {
  createKnowledgeMemoryModule,
  createSkillMemoryModule,
  createFileMemoryPolicyStore,
  type MemoryRevisionExecutor,
} from "@pragma/memory";
import { SkillSourceSnapshotSchema, KnowledgeSourceSnapshotSchema } from "@pragma/shared";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import {
  MissionStoreError,
  type LocalHostMissionApplication,
  type MissionStore,
} from "@pragma/local-host";
import { STORE_REVISION_EXPERT_REF, SKILL_REVISION_EXPERT_REF } from "@pragma/built-in-agents";
import { createLegacyMemoryRevisionObserver } from "./legacy-memory-revision-observer.ts";
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it.each(["running", "succeeded", "failed"])(
  "only observes registered historical %s work",
  async (status) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-legacy-observer-"));
    roots.push(root);
    const registry = join(root, "state", "memory-revision-planning");
    await mkdir(registry, { recursive: true });
    const id = randomUUID();
    await writeFile(join(registry, id), "");
    const startRun = vi.fn(),
      remove = vi.fn(async () => undefined),
      continuation = vi.fn();
    const observer = createLegacyMemoryRevisionObserver({
      pragmaHome: root,
      missions: {
        get: async () => ({
          id,
          executor: { ref: STORE_REVISION_EXPERT_REF },
          origin: { type: "system-memory", jobId: `knowledge-plan:${"a".repeat(64)}` },
          execution: { id: "execution-1", status },
        }),
      } as unknown as MissionStore,
      application: {
        startRun,
        delete: remove,
        continueInternalMemoryMission: continuation,
        getInternalConversationSnapshot: async () => ({
          entries: [
            { kind: "assistant", executionId: "earlier", content: "invalid" },
            {
              kind: "assistant",
              executionId: "execution-1",
              content: '{"action":"skip","reason":"No delta"}',
            },
          ],
        }),
      } as unknown as LocalHostMissionApplication,
    });
    expect(await observer.knowledge.hasPending("a".repeat(64))).toBe(true);
    const observed = observer.knowledge.plan({
      sourceDigest: "a".repeat(64),
      signal: new AbortController().signal,
    } as Parameters<typeof observer.knowledge.plan>[0]);
    if (status === "succeeded") expect(await observed).toMatchObject({ action: "skip" });
    else
      await expect(observed).rejects.toThrow(
        status === "running"
          ? "memory_revision_observation_pending"
          : "memory_legacy_revision_failed",
      );
    expect(startRun).not.toHaveBeenCalled();
    expect(continuation).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    if (status === "running")
      expect(await observer.knowledge.prepareDirectRetry("a".repeat(64))).toBe(false);
    else {
      expect(await observer.knowledge.prepareDirectRetry("a".repeat(64))).toBe(true);
      expect(await observer.knowledge.hasPending("a".repeat(64))).toBe(false);
      expect(remove).toHaveBeenCalledOnce();
    }
  },
);

it.each(["knowledge", "skill"] as const)(
  "isolates an anonymous missing legacy owner from new %s work",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-legacy-orphan-"));
    roots.push(root);
    const registry = join(root, "state", "memory-revision-planning");
    await mkdir(registry, { recursive: true });
    const id = randomUUID();
    const marker = join(registry, id);
    // Exact marker bytes written by the pre-#434 Planner registry.
    await writeFile(marker, "");
    const timestamp = new Date("2026-10-01T00:00:00.000Z");
    await utimes(marker, timestamp, timestamp);
    const remove = vi.fn();
    const observer = createLegacyMemoryRevisionObserver({
      pragmaHome: root,
      missions: {
        get: async () => {
          throw new MissionStoreError("mission_not_found", "deleted");
        },
      } as unknown as MissionStore,
      application: { delete: remove } as unknown as LocalHostMissionApplication,
    });
    expect(await observer[kind].hasPending("a".repeat(64))).toBe(false);
    expect(
      await observer[kind].hasPending("a".repeat(64), {
        taskCreatedAt: "2026-10-02T00:00:00.000Z",
        mayHaveRun: true,
      }),
    ).toBe(false);
    await expect(
      observer[kind].hasPending("a".repeat(64), {
        taskCreatedAt: "2026-09-30T00:00:00.000Z",
        mayHaveRun: true,
      }),
    ).rejects.toThrow("memory_legacy_revision_owner_missing");
    expect(
      await observer[kind].hasPending("a".repeat(64), {
        taskCreatedAt: "2026-09-30T00:00:00.000Z",
        mayHaveRun: false,
      }),
    ).toBe(false);
    expect(
      await observer[kind].prepareDirectRetry("a".repeat(64), {
        taskCreatedAt: "2026-10-02T00:00:00.000Z",
        mayHaveRun: true,
      }),
    ).toBe(true);
    await expect(observer[kind].prepareDirectRetry("a".repeat(64))).rejects.toThrow(
      "memory_legacy_revision_owner_missing",
    );
    expect(await readFile(marker, "utf8")).toBe("");
    expect(remove).not.toHaveBeenCalled();
  },
);

it.each(["knowledge", "skill"] as const)(
  "persists %s source identity before its legacy Mission disappears",
  async (kind) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-legacy-identity-"));
    roots.push(root);
    const registry = join(root, "state", "memory-revision-planning");
    await mkdir(registry, { recursive: true });
    const id = randomUUID();
    await writeFile(join(registry, id), "");
    let missing = false;
    const remove = vi.fn();
    const options = {
      pragmaHome: root,
      missions: {
        get: async () => {
          if (missing) throw new MissionStoreError("mission_not_found", "deleted");
          return {
            id,
            executor: {
              ref: kind === "knowledge" ? STORE_REVISION_EXPERT_REF : SKILL_REVISION_EXPERT_REF,
            },
            origin: { type: "system-memory", jobId: `${kind}-plan:${"a".repeat(64)}` },
            execution: { id: "execution-1", status: "running" },
          };
        },
      } as unknown as MissionStore,
      application: { delete: remove } as unknown as LocalHostMissionApplication,
    };
    let observer = createLegacyMemoryRevisionObserver(options);
    expect(await observer[kind].hasPending("a".repeat(64))).toBe(true);
    const identityPath = join(root, "state", "memory-legacy-planner-identities-v1", `${id}.json`);
    const identity = JSON.parse(await readFile(identityPath, "utf8"));
    expect(identity).toMatchObject({
      schemaVersion: "pragma.memory-legacy-planner-identity/v1",
      missionId: id,
      kind,
      sourceDigest: "a".repeat(64),
    });
    // An interrupted atomic write does not replace the last committed identity.
    await rm(identityPath);
    await writeFile(`${identityPath}.interrupted.tmp`, "partial");
    observer = createLegacyMemoryRevisionObserver(options);
    expect(await observer[kind].hasPending("a".repeat(64))).toBe(true);
    missing = true;
    observer = createLegacyMemoryRevisionObserver(options);
    expect(await observer.knowledge.hasPending("b".repeat(64))).toBe(false);
    expect(await observer.skill.hasPending("b".repeat(64))).toBe(false);
    await expect(observer[kind].hasPending("a".repeat(64))).rejects.toThrow(
      "memory_legacy_revision_owner_missing",
    );
    await expect(observer[kind].prepareDirectRetry("a".repeat(64))).rejects.toThrow(
      "memory_legacy_revision_owner_missing",
    );
    expect(await readFile(join(registry, id), "utf8")).toBe("");
    const future = JSON.stringify({
      ...identity,
      schemaVersion: "pragma.memory-legacy-planner-identity/v2",
    });
    await writeFile(identityPath, future);
    await expect(observer[kind].hasPending("a".repeat(64))).rejects.toThrow(
      "memory_legacy_revision_identity_invalid",
    );
    expect(await readFile(identityPath, "utf8")).toBe(future);
    expect(remove).not.toHaveBeenCalled();
  },
);

it.each([
  ["knowledge", true],
  ["skill", true],
  ["knowledge", false],
  ["skill", false],
] as const)(
  "isolates legacy markers through %s module retries (marker older: %s)",
  async (kind, markerOlder) => {
    const root = await mkdtemp(join(tmpdir(), "pragma-legacy-module-"));
    roots.push(root);
    const registry = join(root, "state", "memory-revision-planning");
    await mkdir(registry, { recursive: true });
    const marker = join(registry, randomUUID());
    await writeFile(marker, "");
    const timestamp = new Date(
      markerOlder ? "2026-10-01T00:00:00.000Z" : "2026-10-03T00:00:00.000Z",
    );
    await utimes(marker, timestamp, timestamp);
    const observer = createLegacyMemoryRevisionObserver({
      pragmaHome: root,
      missions: {
        get: async () => {
          throw new MissionStoreError("mission_not_found", "deleted");
        },
      } as unknown as MissionStore,
      application: {} as LocalHostMissionApplication,
    });
    let clock = new Date("2026-10-02T00:00:00.000Z");
    await createFileMemoryPolicyStore({ pragmaHome: root, now: () => clock }).updateGlobal({
      expectedRevision: 0,
      policy: {
        enabled: "enabled",
        capture: "enabled",
        recall: "enabled",
        learning: "local-candidates",
      },
    });
    const sourceInput = {
      ref: { kind: "episodic", id: "episode-1", revision: 1 },
      rootRef: { type: "pragma.expert", id: "0000000000000002" },
      producerRefs: [{ type: "pragma.expert", id: "0000000000000002" }],
      sourceExecutionIds: ["execution-1"],
      title: "Verified workflow",
      body: "A verified workflow.",
      observedAt: "2026-10-01T00:00:00.000Z",
      outcome: "succeeded",
      verified: true,
      sensitivity: "internal",
      visibility: { mode: "host-private" },
    };
    const source = SkillSourceSnapshotSchema.parse({
      ...sourceInput,
      hasSuccessfulRecovery: false,
    });
    const knowledgeSource = KnowledgeSourceSnapshotSchema.parse(sourceInput);
    const execute = vi
      .fn<MemoryRevisionExecutor["execute"]>(async (input) => {
        await input.assertCurrent();
        return {
          submitted: false,
          decision: { outcome: "accumulate", reason: "No supported delta", targets: [] },
        };
      })
      .mockRejectedValueOnce(
        Object.assign(new Error("memory_revision_fixture_failure"), { retryable: false }),
      );
    const shared = {
      pragmaHome: root,
      now: () => clock,
      sourceReader: { listEligibleSources: async () => [source] },
      executor: { execute },
      learningSink: { submit: vi.fn() },
    };
    const module =
      kind === "knowledge"
        ? await createKnowledgeMemoryModule({
            ...shared,
            planner: observer.knowledge,
            sourceReader: { listEligibleSources: async () => [knowledgeSource] },
          })
        : await createSkillMemoryModule({
            ...shared,
            planner: observer.skill,
            targetReader: { listTargets: async () => [] },
          });
    try {
      await module.scheduleRoot(source.rootRef);
      clock = new Date("2026-10-04T00:00:00.000Z");
      await module.runBackgroundOnce?.();
      const job = (await module.store.listJobs())[0]!;
      expect(job).toMatchObject({ status: "needs_attention" });
      expect(execute).toHaveBeenCalledOnce();
      await module.store.retryJob({ id: job.id, expectedRevision: job.revision, now: clock });
      clock = new Date(clock.getTime() + 1000);
      await module.runBackgroundOnce?.();
      if (markerOlder) {
        expect(execute).toHaveBeenCalledTimes(2);
        expect((await module.store.listJobs())[0]).toMatchObject({ status: "completed" });
      } else {
        expect(execute).toHaveBeenCalledOnce();
        expect((await module.store.listJobs())[0]).toMatchObject({
          status: "needs_attention",
          lastErrorCode: "memory_legacy_revision_owner_missing",
        });
      }
      expect(await readFile(marker, "utf8")).toBe("");
    } finally {
      module.close();
    }
  },
);
