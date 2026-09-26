import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import {
  SkillPackageSchema,
  type ExistingMemorySkillTarget,
  type KnowledgeSourceSnapshot,
  type SkillSourceSnapshot,
} from "@pragma/shared";
import type { KnowledgeLearningPlan, SkillLearningPlan } from "@pragma/memory";
import { z } from "zod";

import type { ContextStoreRevisionService } from "../context-stores/context-store-revision-service.ts";
import {
  ContextStoreStoreError,
  type ContextStoreStore,
} from "../context-stores/context-store-store.ts";
import type { SkillRevisionService } from "../capabilities/skill-revision-service.ts";
import { CapabilityStoreError, type CapabilityStore } from "../capabilities/capability-store.ts";
import { ContextStoreSnapshotFileSchema } from "../../../shared/contracts/index.ts";

const KnowledgeBindingSchema = z
  .object({
    expertRef: z.string(),
    storeId: z.string().uuid(),
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
    schemaVersion: z.literal("pragma.memory-learning-revisions/v1"),
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
  schemaVersion: "pragma.memory-learning-revisions/v1",
  knowledge: [],
  skills: [],
};

export function createMemoryLearningRevisions(options: {
  readonly statePath: string;
  readonly knowledgeRevisions: ContextStoreRevisionService;
  readonly skillRevisions: SkillRevisionService;
  readonly contextStores: ContextStoreStore;
  readonly capabilities: CapabilityStore;
  readonly expertExists: (ref: string) => Promise<boolean>;
  readonly mountStore: (expertRef: string, storeId: string) => Promise<void>;
  readonly bindSkill: (expertRef: string, capabilityId: string) => Promise<void>;
}) {
  const path = join(options.statePath, "bindings.json");
  const lockPath = join(options.statePath, ".lock");
  const legacyRoot = dirname(options.statePath);
  const archiveRoot = join(dirname(legacyRoot), "archives", "memory-learning-v1");
  let archived = false;
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
  const read = async (): Promise<State> => {
    try {
      const current = StateSchema.parse(JSON.parse(await readFile(path, "utf8")));
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
    async submitKnowledge(input: {
      readonly expertRef: string;
      readonly sourceDigest: string;
      readonly plan: Extract<KnowledgeLearningPlan, { action: "apply" }>;
      readonly sources: readonly KnowledgeSourceSnapshot[];
    }): Promise<void> {
      if (!(await options.expertExists(input.expertRef))) return;
      await locked(async (state) => {
        const existing = state.knowledge.find((item) => item.expertRef === input.expertRef);
        if (existing?.sourceDigest === input.sourceDigest && existing.revisionJobId !== undefined)
          return;
        if (existing?.revisionPending === true && existing.revisionJobId !== undefined)
          throw new Error("memory_revision_pending");
        const storeId = existing?.storeId ?? randomUUID();
        const operation: "revise" | "create" = existing?.mounted === true ? "revise" : "create";
        const prompt = knowledgePrompt(input.sources);
        const pending = {
          expertRef: input.expertRef,
          storeId,
          sourceDigest: input.sourceDigest,
          mounted: existing?.mounted ?? false,
          revisionPending: true,
        };
        await write({
          ...state,
          knowledge: [
            ...state.knowledge.filter((item) => item.expertRef !== input.expertRef),
            pending,
          ],
        });
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
        await write({
          ...state,
          knowledge: [
            ...state.knowledge.filter((item) => item.expertRef !== input.expertRef),
            { ...pending, revisionJobId: job.id },
          ],
        });
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
          const prompt = skillPrompt(change, input.sources);
          const pending = {
            expertRef: input.expertRef,
            capabilityId,
            normalizedKey: change.normalizedKey,
            sourceDigest: digest,
            mounted: existing?.mounted ?? false,
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
          const job = await options.skillRevisions.start(request);
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
    async listSkillTargets(input: {
      readonly expertRef: string;
    }): Promise<readonly ExistingMemorySkillTarget[]> {
      return await locked(async (state) => {
        const targets: ExistingMemorySkillTarget[] = [];
        for (const item of state.skills.filter(
          (candidate) =>
            candidate.expertRef === input.expertRef &&
            candidate.mounted &&
            candidate.revisionJobId !== undefined,
        )) {
          if (item.revisionJobId === undefined) continue;
          const capability = await options.capabilities.get(item.capabilityId);
          if (capability.definition.kind !== "skill") {
            throw new Error("memory_skill_target_not_skill");
          }
          targets.push({
            bindingId: item.revisionJobId,
            capabilityId: item.capabilityId,
            name: capability.definition.name,
            description: capability.definition.description,
            normalizedKeys: [item.normalizedKey],
          });
        }
        return targets;
      });
    },
    async reconcile(): Promise<boolean> {
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
          const job = await options.skillRevisions.get(item.revisionJobId);
          if (job.state === "rejected") {
            settled = true;
            next = {
              ...next,
              skills: item.mounted
                ? next.skills.map((binding) =>
                    binding === item ? { ...binding, revisionPending: false } : binding,
                  )
                : next.skills.filter((binding) => binding !== item),
            };
            continue;
          }
          if (job.state !== "completed") continue;
          if (!item.mounted) await options.bindSkill(item.expertRef, item.capabilityId);
          settled = true;
          next = {
            ...next,
            skills: next.skills.map((binding) =>
              binding === item ? { ...binding, mounted: true, revisionPending: false } : binding,
            ),
          };
        }
        if (next !== state) await write(next);
        return settled;
      });
    },
  };
}

function knowledgePrompt(sources: readonly KnowledgeSourceSnapshot[]): string {
  const sourceText = JSON.stringify(sources.map(compactSource));
  if (Buffer.byteLength(sourceText, "utf8") > 40_000) {
    throw new Error("knowledge_learning_prompt_too_large");
  }
  return [
    "Create or revise this knowledge base using only the supplied Memory projections. Facts are current beliefs; Episodes are historical context. Preserve unrelated published content. Submit a sparse draft for human review.",
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
  if (Buffer.byteLength(sourceText, "utf8") > 40_000) {
    throw new Error("skill_learning_prompt_too_large");
  }
  return [
    "Create or revise a complete reusable Skill from these Memory projections. Submit the managed draft for human review. Do not add source replay expectations or boundary-case tests solely for Memory learning.",
    `Name: ${change.name}`,
    `Description: ${change.description}`,
    `Sources: ${sourceText}`,
  ].join("\n\n");
}

function compactSource<T extends KnowledgeSourceSnapshot | SkillSourceSnapshot>(source: T): T {
  return {
    ...source,
    body: source.body.slice(0, 1_500),
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
