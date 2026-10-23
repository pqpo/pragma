import { MEMORY_LEARNING_MAX_PROMPT_BYTES } from "@pragma/shared";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  withFileLock,
  defineStateMigrationChain,
  applyAtomicStateMigration,
  recoverAtomicStateMigration,
  MEMORY_LEARNING_REVISION_MIGRATIONS,
} from "@pragma/core";
import {
  SkillPackageSchema,
  type ExistingMemorySkillTarget,
  type KnowledgeSourceSnapshot,
  type SkillSourceSnapshot,
} from "@pragma/shared";
import type {
  ExistingKnowledgeLearningTarget,
  KnowledgeLearningPlan,
  SkillLearningPlan,
} from "@pragma/memory";
import { z } from "zod";

import type { ContextStoreRevisionService } from "../context-stores/context-store-revision-service.ts";
import { ContextStoreStoreError, type ContextStoreStore } from "@pragma/local-host/deployment";
import type { SkillRevisionService } from "../capabilities/skill-revision-service.ts";
import { CapabilityStoreError, type CapabilityStore } from "@pragma/local-host/deployment";
import { ContextStoreSnapshotFileSchema } from "../../../shared/contracts/index.ts";

const KnowledgeBindingSchema = z
  .object({
    expertRef: z.string(),
    storeId: z.string().uuid(),
    topicKey: z.string().min(1),
    topicName: z.string().optional(),
    topicDescription: z.string().optional(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    revisionJobId: z.string().uuid().optional(),
    mounted: z.boolean(),
    revisionPending: z.boolean(),
  })
  .strict();
const SkillBindingSchema = z
  .object({
    expertRef: z.string(),
    capabilityId: z.string().min(1),
    normalizedKey: z.string(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    revisionJobId: z.string().uuid().optional(),
    mounted: z.boolean(),
    revisionPending: z.boolean(),
  })
  .strict();
const StateSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-learning-revisions/v2"),
    knowledge: z.array(KnowledgeBindingSchema),
    skills: z.array(SkillBindingSchema),
  })
  .strict();
const LegacyKnowledgeBindingsSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-knowledge-store-bindings/v1"),
    bindings: z.array(
      z
        .object({
          expertRef: z.string(),
          storeId: z.string().uuid().optional(),
          lastSourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
          updatedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();
const LegacySkillBindingsSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-skill-bindings/v1"),
    bindings: z.array(
      z
        .object({
          bindingId: z.string().uuid(),
          expertRef: z.string(),
          capabilityId: z.string(),
          normalizedKeys: z.array(z.string().min(1)),
          lastSourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
          updatedAt: z.string().datetime(),
        })
        .strict(),
    ),
  })
  .strict();
const LegacyKnowledgeJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-knowledge-promotion-journal/v1"),
    candidateId: z.string().uuid(),
    expertRef: z.string(),
    storeId: z.string().uuid(),
  })
  .strict();
const LegacySkillJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-skill-promotion-journal/v1"),
    candidateId: z.string().uuid(),
    expertRef: z.string(),
    capabilityId: z.string(),
  })
  .strict();
const LegacyKnowledgeCandidateSchema = z
  .object({
    schemaVersion: z.enum([
      "pragma.memory-knowledge-initialization-candidate/v1",
      "pragma.memory-knowledge-initialization-candidate/v2",
    ]),
    id: z.string().uuid(),
    expertRef: z.string(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    name: z.string().trim().min(1),
    description: z.string(),
    files: ContextStoreSnapshotFileSchema.array().min(1),
    state: z.enum(["pending_review", "created"]),
  })
  .passthrough();
const LegacySkillCandidateSchema = z
  .object({
    schemaVersion: z.enum(["pragma.memory-skill-candidate/v1", "pragma.memory-skill-candidate/v2"]),
    id: z.string().uuid(),
    expertRef: z.string(),
    sourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    normalizedKey: z.string().min(1),
    package: SkillPackageSchema,
    state: z.enum(["approved", "promoted"]),
  })
  .passthrough();
type State = z.infer<typeof StateSchema>;
const EMPTY: State = {
  schemaVersion: "pragma.memory-learning-revisions/v2",
  knowledge: [],
  skills: [],
};

export function createMemoryLearningRevisions(options: {
  readonly statePath: string;
  readonly skillWorkspacePath: string;
  readonly knowledgeRevisions: ContextStoreRevisionService;
  readonly skillRevisions: SkillRevisionService;
  readonly contextStores: ContextStoreStore;
  readonly capabilities: CapabilityStore;
  readonly expertExists: (ref: string) => Promise<boolean>;
  readonly mountedAssets?: (
    ref: string,
  ) => Promise<{ readonly stores: readonly string[]; readonly skills: readonly string[] }>;
  readonly mountStore: (expertRef: string, storeId: string) => Promise<void>;
  readonly bindSkill: (expertRef: string, capabilityId: string) => Promise<void>;
}) {
  const path = join(options.statePath, "bindings.json");
  const lockPath = join(options.statePath, ".lock");
  const legacyRoot = dirname(options.statePath);
  const archiveRoot = join(dirname(legacyRoot), "archives", "memory-learning-v1");
  let archived = false;
  let revisionWaitsRecovered = false;
  const archiveLegacy = async (): Promise<void> => {
    if (archived) return;
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 });
    for (const name of ["memory-knowledge-promotion", "memory-skill-promotion"]) {
      try {
        await rename(join(legacyRoot, name), join(archiveRoot, name));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    archived = true;
  };
  const recoverLegacyKnowledge = async (): Promise<
    z.infer<typeof KnowledgeBindingSchema> | undefined
  > => {
    const directory = join(legacyRoot, "memory-knowledge-promotion");
    const journal = await readOptionalJson(
      join(directory, "promotion.json"),
      LegacyKnowledgeJournalSchema,
    );
    if (journal === undefined) return undefined;
    const candidate = LegacyKnowledgeCandidateSchema.parse(
      JSON.parse(
        await readFile(join(directory, "candidates", `${journal.candidateId}.json`), "utf8"),
      ),
    );
    if (candidate.id !== journal.candidateId || candidate.expertRef !== journal.expertRef) {
      throw new Error("memory_legacy_knowledge_journal_mismatch");
    }
    if (!(await options.expertExists(journal.expertRef))) {
      throw new Error("memory_legacy_knowledge_expert_missing");
    }
    let storeExists = true;
    try {
      await options.contextStores.getSnapshot(journal.storeId);
    } catch (error) {
      if (!(error instanceof ContextStoreStoreError) || error.code !== "store_not_found") {
        throw error;
      }
      storeExists = false;
    }
    if (!storeExists) {
      await options.contextStores.createFromSnapshot({
        id: journal.storeId,
        name: candidate.name,
        description: candidate.description,
        files: candidate.files,
        author: "memory-initialization",
        summary: "Recover approved Memory knowledge promotion during upgrade.",
      });
    }
    await options.mountStore(journal.expertRef, journal.storeId);
    return {
      expertRef: journal.expertRef,
      storeId: journal.storeId,
      topicKey: `legacy:${journal.storeId}`,
      sourceDigest: candidate.sourceDigest,
      revisionJobId: randomUUID(),
      mounted: true,
      revisionPending: false,
    };
  };
  const recoverLegacySkill = async (): Promise<z.infer<typeof SkillBindingSchema> | undefined> => {
    const directory = join(legacyRoot, "memory-skill-promotion");
    const journal = await readOptionalJson(
      join(directory, "promotion.json"),
      LegacySkillJournalSchema,
    );
    if (journal === undefined) return undefined;
    const candidate = LegacySkillCandidateSchema.parse(
      JSON.parse(
        await readFile(join(directory, "candidates", `${journal.candidateId}.json`), "utf8"),
      ),
    );
    if (candidate.id !== journal.candidateId || candidate.expertRef !== journal.expertRef) {
      throw new Error("memory_legacy_skill_journal_mismatch");
    }
    if (!(await options.expertExists(journal.expertRef))) {
      throw new Error("memory_legacy_skill_expert_missing");
    }
    try {
      const capability = await options.capabilities.get(journal.capabilityId);
      if (capability.definition.kind !== "skill") {
        throw new Error("memory_legacy_skill_target_not_skill");
      }
    } catch (error) {
      if (!(error instanceof CapabilityStoreError) || error.code !== "capability_not_found") {
        throw error;
      }
      await options.capabilities.createGeneratedSkill({
        package: candidate.package,
        id: journal.capabilityId,
      });
    }
    await options.bindSkill(journal.expertRef, journal.capabilityId);
    return {
      expertRef: journal.expertRef,
      capabilityId: journal.capabilityId,
      normalizedKey: candidate.normalizedKey,
      sourceDigest: candidate.sourceDigest,
      revisionJobId: randomUUID(),
      mounted: true,
      revisionPending: false,
    };
  };
  const chain = defineStateMigrationChain({
    family: "pragma.memory-learning-revisions",
    currentVersion: 2,
    currentSchema: StateSchema,
    steps: MEMORY_LEARNING_REVISION_MIGRATIONS,
  });
  const migration = {
    aggregateRoot: options.statePath,
    journalFile: join(options.statePath, "migration-v2.json"),
    resource: { family: "pragma.memory-learning-revisions", id: "bindings" },
    validateDocuments(documents: Readonly<Record<string, unknown>>) {
      if (
        Object.keys(documents).some(
          (key) => key !== "bindings.json" && key !== "migration-backups/bindings-v1.json",
        )
      )
        throw new Error("memory_learning_migration_invalid_documents");
      const current = StateSchema.parse(documents["bindings.json"]);
      const historical = MEMORY_LEARNING_REVISION_MIGRATIONS[0].inputSchema.parse(
        documents["migration-backups/bindings-v1.json"],
      );
      if (JSON.stringify(chain.upgrade(historical).value) !== JSON.stringify(current))
        throw new Error("memory_learning_migration_invalid_result");
    },
  };
  const read = async (): Promise<State> => {
    try {
      const beforeRecovery = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return undefined;
        throw error;
      });
      if (beforeRecovery !== undefined) chain.upgrade(JSON.parse(beforeRecovery));
      await recoverAtomicStateMigration(migration);
      const raw: unknown = JSON.parse(await readFile(path, "utf8"));
      const upgraded = chain.upgrade(raw);
      if (upgraded.migrated)
        await applyAtomicStateMigration({
          ...migration,
          fromVersion: upgraded.fromVersion,
          toVersion: upgraded.toVersion,
          documents: { "bindings.json": upgraded.value, "migration-backups/bindings-v1.json": raw },
        });
      const current = upgraded.value;
      await archiveLegacy();
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        const legacyKnowledge = await readLegacyBindings(
          join(legacyRoot, "memory-knowledge-promotion", "bindings.json"),
          LegacyKnowledgeBindingsSchema,
        );
        const legacySkills = await readLegacyBindings(
          join(legacyRoot, "memory-skill-promotion", "bindings.json"),
          LegacySkillBindingsSchema,
        );
        const recoveredKnowledge = await recoverLegacyKnowledge();
        const recoveredSkill = await recoverLegacySkill();
        const migrated = StateSchema.parse({
          ...EMPTY,
          knowledge: [
            ...legacyKnowledge
              .filter((entry) => entry.expertRef !== recoveredKnowledge?.expertRef)
              .flatMap((entry) =>
                entry.storeId !== undefined
                  ? [
                      {
                        expertRef: entry.expertRef,
                        storeId: entry.storeId,
                        topicKey: `legacy:${entry.storeId}`,
                        sourceDigest: entry.lastSourceDigest,
                        revisionJobId: randomUUID(),
                        mounted: true,
                        revisionPending: false,
                      },
                    ]
                  : [],
              ),
            ...(recoveredKnowledge === undefined ? [] : [recoveredKnowledge]),
          ],
          skills: [
            ...legacySkills
              .flatMap((entry) =>
                entry.normalizedKeys.length > 0
                  ? entry.normalizedKeys.map((normalizedKey) => ({
                      expertRef: entry.expertRef,
                      capabilityId: entry.capabilityId,
                      normalizedKey,
                      sourceDigest: entry.lastSourceDigest,
                      revisionJobId: randomUUID(),
                      mounted: true,
                      revisionPending: false,
                    }))
                  : [],
              )
              .filter(
                (entry) =>
                  !(
                    entry.expertRef === recoveredSkill?.expertRef &&
                    entry.capabilityId === recoveredSkill.capabilityId
                  ),
              ),
            ...(recoveredSkill === undefined ? [] : [recoveredSkill]),
          ],
        });
        await write(migrated);
        await archiveLegacy();
        return migrated;
      }
      throw error;
    }
  };
  const write = async (state: State): Promise<void> => {
    await mkdir(options.statePath, { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(StateSchema.parse(state))}\n`, { mode: 0o600 });
    await rename(temporary, path);
  };
  const locked = async <T>(callback: (state: State) => Promise<T>): Promise<T> =>
    await withFileLock(lockPath, async () => await callback(await read()));

  return {
    async clearExpertBinding(expertRef: string): Promise<void> {
      await locked(
        async (state) =>
          await write({
            ...state,
            knowledge: state.knowledge.filter((item) => item.expertRef !== expertRef),
            skills: state.skills.filter((item) => item.expertRef !== expertRef),
          }),
      );
    },
    async clearStoreBinding(storeId: string): Promise<void> {
      await locked(
        async (state) =>
          await write({
            ...state,
            knowledge: state.knowledge.filter((item) => item.storeId !== storeId),
          }),
      );
    },
    async clearCapabilityBinding(capabilityId: string): Promise<void> {
      await locked(
        async (state) =>
          await write({
            ...state,
            skills: state.skills.filter((item) => item.capabilityId !== capabilityId),
          }),
      );
    },
    async assertKnowledgeAvailable(input: {
      readonly expertRef: string;
      readonly sourceDigest: string;
      readonly plan?: Extract<KnowledgeLearningPlan, { action: "apply" }>;
    }): Promise<void> {
      await locked(async (state) => {
        const target = input.plan?.target;
        if (target === undefined) {
          // Historical callers have no selected target. Do not block unrelated experts.
          if (
            state.knowledge.some(
              (item) =>
                item.expertRef === input.expertRef &&
                item.revisionPending &&
                item.revisionJobId !== undefined &&
                item.sourceDigest !== input.sourceDigest,
            )
          )
            throw new Error("memory_revision_pending");
          return;
        }
        if (
          state.knowledge.some(
            (item) =>
              item.revisionPending &&
              item.revisionJobId !== undefined &&
              (target.type === "revise"
                ? item.storeId === target.storeId
                : item.expertRef === input.expertRef &&
                  item.topicKey === topicKey(input.plan!.name)),
          )
        )
          throw new Error("memory_revision_pending");
      });
    },
    async assertSkillsAvailable(input: {
      readonly expertRef: string;
      readonly sourceDigest: string;
      readonly plan: Extract<SkillLearningPlan, { action: "apply" }>;
    }): Promise<void> {
      await locked(async (state) => {
        for (const change of input.plan.changes) {
          const digest = createHash("sha256")
            .update(`${input.sourceDigest}\0${change.normalizedKey}`)
            .digest("hex");
          const existing = state.skills.find(
            (item) =>
              item.expertRef === input.expertRef && item.normalizedKey === change.normalizedKey,
          );
          if (existing?.sourceDigest === digest && existing.revisionJobId !== undefined) continue;
          const capabilityId =
            change.target.type === "revise" ? change.target.capabilityId : existing?.capabilityId;
          if (
            (existing?.revisionPending && existing.revisionJobId !== undefined) ||
            (capabilityId !== undefined &&
              state.skills.some(
                (item) =>
                  item !== existing && item.capabilityId === capabilityId && item.revisionPending,
              ))
          )
            throw new Error("memory_revision_pending");
        }
      });
    },
    async submitKnowledge(input: {
      readonly expertRef: string;
      readonly sourceDigest: string;
      readonly plan: Extract<KnowledgeLearningPlan, { action: "apply" }>;
      readonly sources: readonly KnowledgeSourceSnapshot[];
    }): Promise<void> {
      if (!(await options.expertExists(input.expertRef))) return;
      await locked(async (state) => {
        const target = input.plan.target;
        const key = topicKey(input.plan.name);
        const existing = state.knowledge.find(
          (item) =>
            item.expertRef === input.expertRef &&
            (target.type === "revise" ? item.storeId === target.storeId : item.topicKey === key),
        );
        if (existing?.sourceDigest === input.sourceDigest && existing.revisionJobId !== undefined)
          return;
        if (target.type === "create" && existing?.mounted)
          throw Object.assign(new Error("memory_learning_target_already_exists"), {
            retryable: false,
          });
        const storeId =
          target.type === "revise" ? target.storeId : (existing?.storeId ?? randomUUID());
        if (
          state.knowledge.some(
            (item) =>
              item.storeId === storeId && item.revisionPending && item.revisionJobId !== undefined,
          )
        )
          throw new Error("memory_revision_pending");
        if (target.type === "revise") {
          const current = await options.contextStores.get(storeId);
          if (
            current.status !== "ready" ||
            current.contentRevision !== target.baseRevision ||
            current.snapshotHash !== target.snapshotHash
          )
            throw Object.assign(new Error("memory_learning_target_changed"), {
              retryable: current.status === "ready",
            });
        }
        const operation = target.type;
        const prompt = knowledgePrompt(input.sources, input.plan);
        const mounted =
          (await options.mountedAssets?.(input.expertRef))?.stores.includes(storeId) ??
          existing?.mounted ??
          false;
        const pending = {
          expertRef: input.expertRef,
          storeId,
          topicKey: key,
          topicName: input.plan.name,
          topicDescription: input.plan.description,
          sourceDigest: input.sourceDigest,
          mounted,
          revisionPending: true,
        };
        const others = state.knowledge.filter((item) => item !== existing);
        await write({ ...state, knowledge: [...others, pending] });
        const request = {
          schemaVersion: "pragma.context-store-revision-request/v2" as const,
          operation,
          storeId,
          ...(operation === "create"
            ? { resourceName: input.plan.name, resourceDescription: input.plan.description }
            : {}),
          prompt,
          source: "memory-learning" as const,
          sourceDigest: input.sourceDigest,
        };
        const job = await options.knowledgeRevisions.submit(request);
        await write({ ...state, knowledge: [...others, { ...pending, revisionJobId: job.id }] });
        options.knowledgeRevisions.scheduleProcessing();
      });
    },
    async submitSkills(input: {
      readonly expertRef: string;
      readonly sourceDigest: string;
      readonly plan: Extract<SkillLearningPlan, { action: "apply" }>;
      readonly sources: readonly SkillSourceSnapshot[];
    }): Promise<void> {
      if (!(await options.expertExists(input.expertRef))) return;
      await locked(async (initial) => {
        let state = initial;
        for (const change of input.plan.changes) {
          const digest = createHash("sha256")
            .update(`${input.sourceDigest}\0${change.normalizedKey}`)
            .digest("hex");
          const existing = state.skills.find(
            (item) =>
              item.expertRef === input.expertRef && item.normalizedKey === change.normalizedKey,
          );
          if (existing?.sourceDigest === digest && existing.revisionJobId !== undefined) continue;
          if (existing?.revisionPending === true && existing.revisionJobId !== undefined)
            throw new Error("memory_revision_pending");
          const capabilityId =
            change.target.type === "revise"
              ? change.target.capabilityId
              : (existing?.capabilityId ?? randomUUID());
          if (
            state.skills.some(
              (item) =>
                item !== existing && item.capabilityId === capabilityId && item.revisionPending,
            )
          ) {
            throw new Error("memory_revision_pending");
          }
          if (change.target.type === "revise") {
            const current = await options.capabilities.get(capabilityId);
            if (
              current.definition.kind !== "skill" ||
              current.managedBy === "system" ||
              (change.target.baseRevision !== undefined &&
                current.manifest.latestRevision !== change.target.baseRevision) ||
              (change.target.contentHash !== undefined &&
                current.definition.contentHash !== change.target.contentHash)
            )
              throw Object.assign(new Error("memory_learning_target_changed"), {
                retryable: current.definition.kind === "skill" && current.managedBy !== "system",
              });
          }
          const mounted =
            (await options.mountedAssets?.(input.expertRef))?.skills.includes(capabilityId) ??
            existing?.mounted ??
            false;
          const prompt = skillPrompt(change, input.sources);
          const pending = {
            expertRef: input.expertRef,
            capabilityId,
            normalizedKey: change.normalizedKey,
            sourceDigest: digest,
            mounted,
            revisionPending: true,
          };
          state = {
            ...state,
            skills: [
              ...state.skills.filter(
                (item) =>
                  !(
                    item.expertRef === input.expertRef &&
                    item.normalizedKey === change.normalizedKey
                  ),
              ),
              pending,
            ],
          };
          await write(state);
          const request = {
            schemaVersion: "pragma.skill-revision-request/v4" as const,
            operation: change.target.type,
            capabilityId,
            ...(change.target.type === "create"
              ? { resourceName: change.name, resourceDescription: change.description }
              : {}),
            prompt,
            source: "memory-learning" as const,
            sourceDigest: digest,
            sourceRefs: change.sourceRefs,
          };
          await mkdir(options.skillWorkspacePath, { recursive: true, mode: 0o700 });
          const job = await options.skillRevisions.start(request, {
            workspacePath: options.skillWorkspacePath,
          });
          state = {
            ...state,
            skills: [
              ...state.skills.filter(
                (item) =>
                  !(
                    item.expertRef === input.expertRef &&
                    item.normalizedKey === change.normalizedKey
                  ),
              ),
              { ...pending, revisionJobId: job.id },
            ],
          };
          await write(state);
          options.skillRevisions.scheduleProcessing();
        }
      });
    },
    async listKnowledgeTargets(input: {
      readonly expertRef: string;
    }): Promise<readonly ExistingKnowledgeLearningTarget[]> {
      const mounts = await options.mountedAssets?.(input.expertRef);
      return await locked(async (state) => {
        const result: ExistingKnowledgeLearningTarget[] = [];
        for (const store of await options.contextStores.list()) {
          if (store.status !== "ready") continue;
          result.push({
            storeId: store.id,
            name: store.name,
            description: store.description,
            baseRevision: store.contentRevision,
            snapshotHash: store.snapshotHash,
            mounted: mounts?.stores.includes(store.id) ?? false,
            pending: state.knowledge.some(
              (item) => item.storeId === store.id && item.revisionPending,
            ),
          });
        }
        for (const binding of state.knowledge.filter(
          (item) =>
            item.revisionPending && !result.some((target) => target.storeId === item.storeId),
        )) {
          const job =
            binding.revisionJobId === undefined
              ? undefined
              : await options.knowledgeRevisions.get(binding.revisionJobId);
          result.push({
            storeId: binding.storeId,
            name: job?.request?.resourceName ?? binding.topicName ?? "Pending knowledge",
            description:
              job?.request?.resourceDescription ??
              binding.topicDescription ??
              "A knowledge draft is awaiting review.",
            baseRevision: 0,
            snapshotHash: "0".repeat(64),
            mounted: false,
            pending: true,
          });
        }
        return result.toSorted(
          (a, b) => Number(b.mounted) - Number(a.mounted) || a.storeId.localeCompare(b.storeId),
        );
      });
    },
    async readKnowledgeTarget(target: ExistingKnowledgeLearningTarget): Promise<string> {
      if (target.pending)
        return "This related target has an outstanding revision. Wait for its review; do not create a duplicate.";
      const snapshot = await options.contextStores.getSnapshot(target.storeId, target.baseRevision);
      if (snapshot.snapshotHash !== target.snapshotHash)
        throw Object.assign(new Error("memory_learning_target_changed"), { retryable: false });
      return snapshot.files.map((file) => `# ${file.id}\n${file.content}`).join("\n\n");
    },
    async readSkillTarget(target: ExistingMemorySkillTarget): Promise<string> {
      if (target.pending)
        return "This related Skill has an outstanding revision. Wait for its review; do not create a duplicate.";
      const document = await options.capabilities.getSkillDocument({
        id: target.capabilityId,
        revision: target.baseRevision,
      });
      const files = await options.capabilities.listSkillFiles({
        id: target.capabilityId,
        revision: target.baseRevision,
      });
      return JSON.stringify({
        document: document.content,
        files,
        instruction:
          "Read related scripts and references with a target path inspection before proposing an incremental revision. Declare all files used in targetFiles.",
      });
    },
    async readSkillTargetFile(target: ExistingMemorySkillTarget, path: string): Promise<string> {
      if (target.pending) throw new Error("memory_revision_pending");
      const file = await options.capabilities.getSkillFile({
        id: target.capabilityId,
        revision: target.baseRevision,
        path,
      });
      if (file.revision !== target.baseRevision || typeof file.content !== "string")
        throw Object.assign(new Error("memory_learning_target_file_unreadable"), {
          code: "memory_learning_target_file_unreadable",
          retryable: false,
        });
      return file.content;
    },
    async listSkillTargets(input: {
      readonly expertRef: string;
    }): Promise<readonly ExistingMemorySkillTarget[]> {
      const mounts = await options.mountedAssets?.(input.expertRef);
      return await locked(async (state) => {
        const result: ExistingMemorySkillTarget[] = [];
        const candidates = new Map(
          (await options.capabilities.list()).map((item) => [item.manifest.id, item]),
        );
        for (const item of state.skills.filter(
          (item) => item.expertRef === input.expertRef && item.mounted,
        )) {
          const capability = await options.capabilities.get(item.capabilityId);
          if (capability.definition.kind !== "skill")
            throw new Error("memory_skill_target_not_skill");
          candidates.set(item.capabilityId, capability);
        }
        for (const capability of candidates.values()) {
          if (
            capability.definition.kind !== "skill" ||
            capability.managedBy === "system" ||
            capability.health.status !== "ready"
          )
            continue;
          const id = capability.manifest.id;
          const bindings = state.skills.filter((item) => item.capabilityId === id);
          const expertBindings = bindings.filter((item) => item.expertRef === input.expertRef);
          result.push({
            bindingId: bindings[0]?.revisionJobId ?? randomUUID(),
            capabilityId: id,
            name: capability.definition.name,
            description: capability.definition.description,
            normalizedKeys:
              expertBindings.length > 0
                ? [...new Set(expertBindings.map((item) => item.normalizedKey))]
                : [`skill:${id}`],
            mounted:
              mounts?.skills.includes(id) ??
              bindings.some((item) => item.expertRef === input.expertRef && item.mounted),
            pending: bindings.some((item) => item.revisionPending),
            baseRevision: capability.manifest.latestRevision,
            contentHash: capability.definition.contentHash,
          });
        }
        for (const binding of state.skills.filter(
          (item) =>
            item.revisionPending &&
            !result.some((target) => target.capabilityId === item.capabilityId),
        )) {
          const job =
            binding.revisionJobId === undefined
              ? undefined
              : await options.skillRevisions.get(binding.revisionJobId);
          result.push({
            bindingId: binding.revisionJobId ?? randomUUID(),
            capabilityId: binding.capabilityId,
            name: job?.request?.resourceName ?? "Pending Skill",
            description: job?.request?.resourceDescription ?? "A Skill draft is awaiting review.",
            normalizedKeys: state.skills.some(
              (item) =>
                item.capabilityId === binding.capabilityId && item.expertRef === input.expertRef,
            )
              ? state.skills
                  .filter(
                    (item) =>
                      item.capabilityId === binding.capabilityId &&
                      item.expertRef === input.expertRef,
                  )
                  .map((item) => item.normalizedKey)
              : [`skill:${binding.capabilityId}`],
            mounted: false,
            pending: true,
            baseRevision: 0,
            contentHash: "0".repeat(64),
          });
        }
        return result.toSorted(
          (a, b) =>
            Number(b.mounted) - Number(a.mounted) || a.capabilityId.localeCompare(b.capabilityId),
        );
      });
    },
    async reconcile(wakeSettled?: () => Promise<void>): Promise<boolean> {
      return await locked(async (state) => {
        let next = state;
        let settled = false;
        for (const item of state.knowledge.filter(
          (binding) => binding.revisionPending && binding.revisionJobId !== undefined,
        )) {
          if (item.revisionJobId === undefined) continue;
          const job = await options.knowledgeRevisions.get(item.revisionJobId);
          if (job.state === "rejected") {
            settled = true;
            next = {
              ...next,
              knowledge: item.mounted
                ? next.knowledge.map((binding) =>
                    binding === item ? { ...binding, revisionPending: false } : binding,
                  )
                : next.knowledge.filter((binding) => binding !== item),
            };
            continue;
          }
          if (job.state !== "merged") continue;
          if (!item.mounted) await options.mountStore(item.expertRef, item.storeId);
          settled = true;
          next = {
            ...next,
            knowledge: next.knowledge.map((binding) =>
              binding === item ? { ...binding, mounted: true, revisionPending: false } : binding,
            ),
          };
        }
        for (const item of state.skills.filter(
          (binding) => binding.revisionPending && binding.revisionJobId !== undefined,
        )) {
          if (item.revisionJobId === undefined) continue;
          let binding = item;
          let job = await options.skillRevisions.get(item.revisionJobId);
          const visited = new Set([job.id]);
          while (job.state === "superseded") {
            if (job.supersededBy === undefined || visited.has(job.supersededBy)) {
              throw new Error("memory_skill_revision_replacement_invalid");
            }
            const replacement = await options.skillRevisions.get(job.supersededBy);
            if (replacement.request.source !== "memory-learning") {
              throw new Error("memory_skill_revision_replacement_invalid");
            }
            visited.add(replacement.id);
            const previous = binding;
            binding = {
              ...binding,
              revisionJobId: replacement.id,
              capabilityId: replacement.request.capabilityId,
            };
            next = {
              ...next,
              skills: next.skills.map((candidate) =>
                candidate === previous ? binding : candidate,
              ),
            };
            await write(next);
            job = replacement;
          }
          if (job.state === "rejected") {
            settled = true;
            next = {
              ...next,
              skills: binding.mounted
                ? next.skills.map((candidate) =>
                    candidate === binding ? { ...candidate, revisionPending: false } : candidate,
                  )
                : next.skills.filter((candidate) => candidate !== binding),
            };
            continue;
          }
          if (job.state !== "completed") continue;
          if (!binding.mounted) await options.bindSkill(binding.expertRef, binding.capabilityId);
          settled = true;
          next = {
            ...next,
            skills: next.skills.map((candidate) =>
              candidate === binding
                ? { ...candidate, mounted: true, revisionPending: false }
                : candidate,
            ),
          };
        }
        // Wake before committing settlement: a failed wake or interrupted write leaves
        // the durable pending binding available to replay this idempotent operation.
        // The first callback in each process also repairs historical missed wakes.
        if (wakeSettled !== undefined && (settled || !revisionWaitsRecovered)) {
          await wakeSettled();
          revisionWaitsRecovered = true;
        }
        if (next !== state) await write(next);
        return settled;
      });
    },
  };
}

function knowledgePrompt(
  sources: readonly KnowledgeSourceSnapshot[],
  plan: Extract<KnowledgeLearningPlan, { action: "apply" }>,
): string {
  const sourceText = JSON.stringify(sources.map(compactSource));
  if (Buffer.byteLength(sourceText, "utf8") > MEMORY_LEARNING_MAX_PROMPT_BYTES) {
    throw new Error("knowledge_learning_prompt_too_large");
  }
  return [
    "Create or revise this knowledge base using only the supplied Memory projections. Facts are current beliefs; Episodes are historical context. Preserve unrelated published content. Submit a sparse draft for human review.",
    "Apply only the stated incremental change. Compare the existing content first; preserve unrelated material and consolidate duplicates. Correct obsolete claims only when the supplied current evidence supports the correction. Do not generalize a historical Episode into current universal truth.",
    `Proposed change: ${plan.rationale}`,
    "Do not copy source IDs, raw Evidence, Curator prompts, or local paths into published content.",
    `Sources: ${sourceText}`,
  ].join("\n\n");
}

function skillPrompt(
  change: Extract<SkillLearningPlan, { action: "apply" }>["changes"][number],
  sources: readonly SkillSourceSnapshot[],
): string {
  const selected = sources.filter((source) =>
    change.sourceRefs.some(
      (ref) =>
        source.ref.kind === ref.kind &&
        source.ref.id === ref.id &&
        source.ref.revision === ref.revision,
    ),
  );
  const compact = selected.map(compactSource);
  const sourceText = JSON.stringify(compact);
  if (Buffer.byteLength(sourceText, "utf8") > MEMORY_LEARNING_MAX_PROMPT_BYTES) {
    throw new Error("skill_learning_prompt_too_large");
  }
  return [
    "Create or revise a complete reusable Skill from these Memory projections. Submit the managed draft for human review. Do not add source replay expectations or boundary-case tests solely for Memory learning.",
    "Specify applicability, inputs and preconditions, ordered executable steps, actual result verification, and supported failure handling or limitations. Parameterize task-specific names, local paths and data. Never invent successful checks or publish raw Evidence/source IDs. Preserve unrelated existing Skill behavior and focus on the supported procedural improvement.",
    `Name: ${change.name}`,
    `Description: ${change.description}`,
    `Target files used by the plan: ${JSON.stringify(change.targetFiles ?? ["SKILL.md"])}`,
    `Sources: ${sourceText}`,
  ].join("\n\n");
}

function compactSource<T extends KnowledgeSourceSnapshot | SkillSourceSnapshot>(source: T): T {
  return {
    ...source,
    body: source.body,
    sourceExecutionIds: source.sourceExecutionIds.slice(0, 5),
    producerRefs: source.producerRefs.slice(0, 5),
  };
}

async function readLegacyBindings<T extends z.ZodType<{ readonly bindings: readonly unknown[] }>>(
  path: string,
  schema: T,
): Promise<z.infer<T>["bindings"]> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8"))).bindings;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

async function readOptionalJson<T extends z.ZodType>(
  path: string,
  schema: T,
): Promise<z.infer<T> | undefined> {
  try {
    return schema.parse(JSON.parse(await readFile(path, "utf8"))) as z.infer<T>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function topicKey(name: string): string {
  return createHash("sha256")
    .update(name.normalize("NFKC").toLocaleLowerCase().trim())
    .digest("hex");
}
