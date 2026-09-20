import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/core";
import { validateSkillPackage } from "@pragma/built-in-agents";
import type {
  ExistingMemorySkillTarget,
  MemorySubjectRef,
  SkillExtractionCandidate,
  SkillSourceSnapshot,
} from "@pragma/shared";
import { z } from "zod";

import {
  MemorySkillCandidateRefSchema,
  MemorySkillCandidateSchema,
  ResolveMemorySkillTargetSchema,
  UpdateMemorySkillCandidateSchema,
  type MemorySkillCandidate,
  type MemorySkillCandidateRef,
  type ResolveMemorySkillTarget,
  type UpdateMemorySkillCandidate,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { SkillRevisionService } from "../capabilities/skill-revision-service.ts";
import { readMemorySkillCandidateWithMigration } from "./memory-skill-candidate-migrations/index.ts";

const BindingSchema = z
  .object({
    bindingId: z.string().uuid(),
    expertRef: z.string().regex(/^expert:[0-9a-hjkmnp-tv-z]{16}$/u),
    capabilityId: z.string().uuid(),
    normalizedKeys: z.array(z.string().min(1).max(300)).min(1).max(100),
    lastSourceDigest: z.string().regex(/^[a-f0-9]{64}$/u),
    updatedAt: z.string().datetime(),
  })
  .strict();
const BindingFileSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-skill-bindings/v1"),
    bindings: z.array(BindingSchema),
  })
  .strict();
const PromotionJournalSchema = z
  .object({
    schemaVersion: z.literal("pragma.memory-skill-promotion-journal/v1"),
    candidateId: z.string().uuid(),
    expertRef: z.string(),
    capabilityId: z.string().uuid(),
  })
  .strict();

export interface MemorySkillPromotionService {
  readonly targetReader: {
    listTargets(input: {
      readonly expertRef: string;
    }): Promise<readonly ExistingMemorySkillTarget[]>;
  };
  routeLearning(input: {
    readonly expertRef: string;
    readonly sourceDigest: string;
    readonly candidates: readonly SkillExtractionCandidate[];
  }): Promise<void>;
  list(input?: {
    readonly state?: MemorySkillCandidate["state"];
  }): Promise<readonly MemorySkillCandidate[]>;
  update(input: UpdateMemorySkillCandidate): Promise<MemorySkillCandidate>;
  resolveTarget(input: ResolveMemorySkillTarget): Promise<MemorySkillCandidate>;
  reject(input: MemorySkillCandidateRef): Promise<MemorySkillCandidate>;
  approve(input: MemorySkillCandidateRef): Promise<MemorySkillCandidate>;
  clearExpertBinding(expertRef: string): Promise<void>;
  clearCapabilityBinding(capabilityId: string): Promise<void>;
  recover(): Promise<void>;
}

export function groupMemorySkillCandidatesByExpert(input: {
  readonly rootRef: MemorySubjectRef;
  readonly candidates: readonly SkillExtractionCandidate[];
  readonly sources: readonly SkillSourceSnapshot[];
}): ReadonlyMap<string, readonly SkillExtractionCandidate[]> {
  const grouped = new Map<string, SkillExtractionCandidate[]>();
  for (const candidate of input.candidates) {
    const sourceKeys = new Set(
      candidate.sourceRefs.map((ref) => `${ref.kind}\0${ref.id}\0${ref.revision}`),
    );
    const experts = input.sources
      .filter((source) =>
        sourceKeys.has(`${source.ref.kind}\0${source.ref.id}\0${source.ref.revision}`),
      )
      .flatMap((source) => source.producerRefs)
      .filter((ref) => ref.type === "pragma.expert")
      .map((ref) => `expert:${ref.id}`);
    if (experts.length === 0 && input.rootRef.type === "pragma.expert")
      experts.push(`expert:${input.rootRef.id}`);
    for (const expertRef of new Set(experts))
      grouped.set(expertRef, [...(grouped.get(expertRef) ?? []), candidate]);
  }
  return grouped;
}

export function createMemorySkillPromotionService(options: {
  readonly statePath: string;
  readonly capabilities: CapabilityStore;
  readonly revisions: SkillRevisionService;
  readonly expertExists: (expertRef: string) => Promise<boolean>;
  readonly bindSkill: (expertRef: string, capabilityId: string, revision: number) => Promise<void>;
}): MemorySkillPromotionService {
  const candidatesPath = join(options.statePath, "candidates");
  const bindingsPath = join(options.statePath, "bindings.json");
  const journalPath = join(options.statePath, "promotion.json");
  const lockPath = join(options.statePath, ".lock");
  const candidatePath = (id: string) => join(candidatesPath, `${id}.json`);

  const readBindings = async () => {
    try {
      return BindingFileSchema.parse(JSON.parse(await readFile(bindingsPath, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return BindingFileSchema.parse({
          schemaVersion: "pragma.memory-skill-bindings/v1",
          bindings: [],
        });
      throw error;
    }
  };
  const writeBindings = async (bindings: z.infer<typeof BindingSchema>[]) =>
    await writeJsonAtomic(bindingsPath, {
      schemaVersion: "pragma.memory-skill-bindings/v1",
      bindings,
    });
  const readCandidate = async (id: string) =>
    await readMemorySkillCandidateWithMigration({
      statePath: options.statePath,
      recordPath: candidatePath(id),
      id,
    });
  const writeCandidate = async (candidate: MemorySkillCandidate) =>
    await writeJsonAtomic(candidatePath(candidate.id), candidate);
  const readCandidates = async () => {
    let names: string[];
    try {
      names = await readdir(candidatesPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    return await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => readCandidate(name.slice(0, -5))),
    );
  };

  const submitRevision = async (
    sourceDigest: string,
    candidate: SkillExtractionCandidate,
    capabilityId: string,
  ) => {
    return await options.revisions.submit({
      schemaVersion: "pragma.skill-revision-submission/v1",
      capabilityId,
      source: "memory-learning",
      sourceDigest: digest(sourceDigest, candidate.content.normalizedKey),
      sourceRefs: candidate.sourceRefs,
      prompt: renderRevisionPrompt(candidate),
    });
  };

  const reconcileRevisionCandidate = async (
    candidate: MemorySkillCandidate,
  ): Promise<MemorySkillCandidate> => {
    if (candidate.state !== "revision_pending" || candidate.revisionJobId === undefined) {
      return candidate;
    }
    let job: Awaited<ReturnType<SkillRevisionService["get"]>>;
    try {
      job = await options.revisions.get(candidate.revisionJobId);
    } catch (error) {
      const lastErrorCode = revisionJobReadFailureCode(error);
      if (candidate.lastErrorCode === lastErrorCode) return candidate;
      const unavailable = MemorySkillCandidateSchema.parse({
        ...candidate,
        revision: candidate.revision + 1,
        lastErrorCode,
        updatedAt: new Date().toISOString(),
      });
      await writeCandidate(unavailable);
      return unavailable;
    }
    if (job.state === "completed") {
      const timestamp = new Date().toISOString();
      const bindings = await readBindings();
      await writeBindings(
        bindings.bindings.map((binding) =>
          binding.expertRef === candidate.expertRef &&
          binding.capabilityId === candidate.capabilityId
            ? {
                ...binding,
                normalizedKeys: [...new Set([...binding.normalizedKeys, candidate.normalizedKey])],
                lastSourceDigest: candidate.sourceDigest,
                updatedAt: timestamp,
              }
            : binding,
        ),
      );
      const promoted = MemorySkillCandidateSchema.parse({
        ...candidate,
        revision: candidate.revision + 1,
        state: "promoted",
        lastErrorCode: undefined,
        updatedAt: timestamp,
      });
      await writeCandidate(promoted);
      return promoted;
    }
    if (["rejected", "superseded"].includes(job.state)) {
      const rejected = MemorySkillCandidateSchema.parse({
        ...candidate,
        revision: candidate.revision + 1,
        state: "rejected",
        lastErrorCode: job.error?.code,
        updatedAt: new Date().toISOString(),
      });
      await writeCandidate(rejected);
      return rejected;
    }
    if (job.state === "needs_attention" && candidate.lastErrorCode !== job.error?.code) {
      const attention = MemorySkillCandidateSchema.parse({
        ...candidate,
        revision: candidate.revision + 1,
        lastErrorCode: job.error?.code ?? "skill_revision_needs_attention",
        updatedAt: new Date().toISOString(),
      });
      await writeCandidate(attention);
      return attention;
    }
    if (candidate.lastErrorCode?.startsWith("memory_skill_revision_job_")) {
      const recovered = MemorySkillCandidateSchema.parse({
        ...candidate,
        revision: candidate.revision + 1,
        lastErrorCode: undefined,
        updatedAt: new Date().toISOString(),
      });
      await writeCandidate(recovered);
      return recovered;
    }
    return candidate;
  };

  const reconcileRevisionCandidates = async (): Promise<MemorySkillCandidate[]> => {
    const reconciled: MemorySkillCandidate[] = [];
    for (const candidate of await readCandidates()) {
      reconciled.push(await reconcileRevisionCandidate(candidate));
    }
    return reconciled;
  };

  const finalizePromotion = async (
    journal: z.infer<typeof PromotionJournalSchema>,
  ): Promise<MemorySkillCandidate> => {
    if (!(await options.expertExists(journal.expertRef))) throw new Error("skill_expert_not_found");
    let candidate = await readCandidate(journal.candidateId);
    let capability;
    try {
      capability = await options.capabilities.get(journal.capabilityId);
    } catch {
      capability = await options.capabilities.createGeneratedSkill({
        package: candidate.package,
        id: journal.capabilityId,
      });
    }
    await options.bindSkill(
      journal.expertRef,
      journal.capabilityId,
      capability.manifest.latestRevision,
    );
    const bindings = await readBindings();
    await writeBindings([
      ...bindings.bindings.filter(
        (binding) =>
          !(
            binding.expertRef === journal.expertRef && binding.capabilityId === journal.capabilityId
          ),
      ),
      {
        bindingId: randomUUID(),
        expertRef: journal.expertRef,
        capabilityId: journal.capabilityId,
        normalizedKeys: [candidate.normalizedKey],
        lastSourceDigest: candidate.sourceDigest,
        updatedAt: new Date().toISOString(),
      },
    ]);
    candidate = MemorySkillCandidateSchema.parse({
      ...candidate,
      revision: candidate.revision + 1,
      state: "promoted",
      capabilityId: journal.capabilityId,
      updatedAt: new Date().toISOString(),
    });
    await writeCandidate(candidate);
    await rm(journalPath, { force: true });
    return candidate;
  };

  const service: MemorySkillPromotionService = {
    targetReader: {
      async listTargets(input) {
        const bindings = await withFileLock(lockPath, async () => {
          await reconcileRevisionCandidates();
          return (await readBindings()).bindings.filter(
            (binding) => binding.expertRef === input.expertRef,
          );
        });
        const targets: ExistingMemorySkillTarget[] = [];
        for (const binding of bindings) {
          try {
            const capability = await options.capabilities.get(binding.capabilityId);
            if (capability.definition.kind !== "skill") continue;
            targets.push({
              bindingId: binding.bindingId,
              capabilityId: binding.capabilityId,
              name: capability.definition.name,
              description: capability.definition.description,
              normalizedKeys: binding.normalizedKeys,
            });
          } catch {
            continue;
          }
        }
        return targets;
      },
    },
    async routeLearning(input) {
      if (!(await options.expertExists(input.expertRef))) return;
      for (const extracted of input.candidates) {
        if (extracted.route.type === "revise") {
          const bindingId = extracted.route.bindingId;
          const binding = await withFileLock(lockPath, async () =>
            (await readBindings()).bindings.find(
              (item) => item.expertRef === input.expertRef && item.bindingId === bindingId,
            ),
          );
          if (binding === undefined) throw new Error("skill_target_binding_missing");
          const job = await submitRevision(input.sourceDigest, extracted, binding.capabilityId);
          await withFileLock(lockPath, async () => {
            const timestamp = new Date().toISOString();
            const existing = (await readCandidates()).find(
              (item) =>
                item.expertRef === input.expertRef &&
                item.normalizedKey === extracted.content.normalizedKey &&
                ["revision_pending", "needs_attention"].includes(item.state),
            );
            await writeCandidate(
              MemorySkillCandidateSchema.parse({
                schemaVersion: "pragma.memory-skill-candidate/v2",
                id: existing?.id ?? randomUUID(),
                revision: (existing?.revision ?? 0) + 1,
                expertRef: input.expertRef,
                sourceDigest: input.sourceDigest,
                normalizedKey: extracted.content.normalizedKey,
                sourceRefs: extracted.sourceRefs,
                package: extracted.content.package,
                route: { type: "revise", bindingId },
                state: "revision_pending",
                capabilityId: binding.capabilityId,
                revisionJobId: job.id,
                createdAt: existing?.createdAt ?? timestamp,
                updatedAt: timestamp,
              }),
            );
          });
          continue;
        }
        const route =
          extracted.route.type === "ambiguous"
            ? {
                type: "needs_target" as const,
                options: (await service.targetReader.listTargets({ expertRef: input.expertRef }))
                  .filter(
                    (target) =>
                      extracted.route.type === "ambiguous" &&
                      extracted.route.bindingIds.includes(target.bindingId),
                  )
                  .map((target) => ({
                    bindingId: target.bindingId,
                    capabilityId: target.capabilityId,
                    name: target.name,
                    description: target.description,
                  })),
              }
            : { type: "create" as const };
        await withFileLock(lockPath, async () => {
          const timestamp = new Date().toISOString();
          const existing = (await readCandidates()).find(
            (item) =>
              item.expertRef === input.expertRef &&
              item.normalizedKey === extracted.content.normalizedKey &&
              ["needs_target", "pending_review", "revision_pending", "needs_attention"].includes(
                item.state,
              ),
          );
          if (existing?.sourceDigest === input.sourceDigest) return undefined;
          const next = MemorySkillCandidateSchema.parse({
            schemaVersion: "pragma.memory-skill-candidate/v2",
            id: existing?.id ?? randomUUID(),
            revision: (existing?.revision ?? 0) + 1,
            expertRef: input.expertRef,
            sourceDigest: input.sourceDigest,
            normalizedKey: extracted.content.normalizedKey,
            sourceRefs: extracted.sourceRefs,
            package: extracted.content.package,
            route,
            state: route.type === "needs_target" ? "needs_target" : "pending_review",
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
          });
          await writeCandidate(next);
          return next;
        });
      }
    },
    async list(input = {}) {
      return await withFileLock(lockPath, async () => {
        const reconciled = await reconcileRevisionCandidates();
        return reconciled
          .filter((candidate) => input.state === undefined || candidate.state === input.state)
          .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
      });
    },
    async update(rawInput) {
      const input = UpdateMemorySkillCandidateSchema.parse(rawInput);
      const next = await withFileLock(lockPath, async () => {
        const current = await readCandidate(input.id);
        assertRevision(current, input.expectedRevision);
        if (!["pending_review", "needs_attention"].includes(current.state))
          throw new Error("skill_candidate_state_invalid");
        const validation = validateSkillPackage(input.package);
        if (!validation.passed) throw validationError(validation.diagnostics);
        const updated = MemorySkillCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          package: input.package,
          state: "pending_review",
          lastErrorCode: undefined,
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(updated);
        return updated;
      });
      return next;
    },
    async resolveTarget(rawInput) {
      const input = ResolveMemorySkillTargetSchema.parse(rawInput);
      const next = await withFileLock(lockPath, async () => {
        const current = await readCandidate(input.id);
        assertRevision(current, input.expectedRevision);
        if (current.state !== "needs_target") throw new Error("skill_candidate_state_invalid");
        if (input.target.type === "revise") {
          const bindingId = input.target.bindingId;
          const option =
            current.route.type === "needs_target"
              ? current.route.options.find((item) => item.bindingId === bindingId)
              : undefined;
          if (option === undefined) throw new Error("skill_target_binding_invalid");
          const job = await options.revisions.submit({
            schemaVersion: "pragma.skill-revision-submission/v1",
            capabilityId: option.capabilityId,
            source: "memory-learning",
            sourceDigest: digest(current.sourceDigest, current.normalizedKey),
            sourceRefs: current.sourceRefs,
            prompt: renderCandidateRevisionPrompt(current),
          });
          const revised = MemorySkillCandidateSchema.parse({
            ...current,
            revision: current.revision + 1,
            route: { type: "revise", bindingId },
            state: "revision_pending",
            capabilityId: option.capabilityId,
            revisionJobId: job.id,
            updatedAt: new Date().toISOString(),
          });
          await writeCandidate(revised);
          return revised;
        }
        const created = MemorySkillCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          route: { type: "create" },
          state: "pending_review",
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(created);
        return created;
      });
      return next;
    },
    async reject(rawInput) {
      const input = MemorySkillCandidateRefSchema.parse(rawInput);
      return await withFileLock(lockPath, async () => {
        const current = await readCandidate(input.id);
        assertRevision(current, input.expectedRevision);
        if (
          !["pending_review", "revision_pending", "needs_attention", "needs_target"].includes(
            current.state,
          )
        )
          throw new Error("skill_candidate_state_invalid");
        const next = MemorySkillCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          state: "rejected",
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(next);
        return next;
      });
    },
    async approve(rawInput) {
      const input = MemorySkillCandidateRefSchema.parse(rawInput);
      return await withFileLock(lockPath, async () => {
        const current = await readCandidate(input.id);
        assertRevision(current, input.expectedRevision);
        if (current.state !== "pending_review")
          throw new Error("skill_candidate_not_approved_for_promotion");
        const validation = validateSkillPackage(current.package);
        if (!validation.passed) throw validationError(validation.diagnostics);
        const approved = MemorySkillCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          state: "approved",
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(approved);
        const journal = PromotionJournalSchema.parse({
          schemaVersion: "pragma.memory-skill-promotion-journal/v1",
          candidateId: approved.id,
          expertRef: approved.expertRef,
          capabilityId: randomUUID(),
        });
        await writeJsonAtomic(journalPath, journal);
        return await finalizePromotion(journal);
      });
    },
    async clearExpertBinding(expertRef) {
      await withFileLock(lockPath, async () => {
        const bindings = await readBindings();
        await writeBindings(bindings.bindings.filter((item) => item.expertRef !== expertRef));
      });
    },
    async clearCapabilityBinding(capabilityId) {
      await withFileLock(lockPath, async () => {
        const bindings = await readBindings();
        await writeBindings(bindings.bindings.filter((item) => item.capabilityId !== capabilityId));
      });
    },
    async recover() {
      await withFileLock(lockPath, async () => {
        try {
          const journal = PromotionJournalSchema.parse(
            JSON.parse(await readFile(journalPath, "utf8")),
          );
          await finalizePromotion(journal);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await reconcileRevisionCandidates();
      });
    },
  };
  return service;
}

function renderRevisionPrompt(candidate: SkillExtractionCandidate): string {
  return [
    "Revise this Skill with the newly learned reusable pattern. Preserve unrelated behavior and keep one coherent workflow.",
    JSON.stringify({
      normalizedKey: candidate.content.normalizedKey,
      applicability: candidate.content.applicability,
      failureModes: candidate.content.failureModes,
      recoverySteps: candidate.content.recoverySteps,
      proposedPackage: candidate.content.package,
    }),
  ].join("\n\n");
}
function renderCandidateRevisionPrompt(candidate: MemorySkillCandidate): string {
  return [
    "Revise this Skill using the reviewed Memory learning candidate. Preserve unrelated behavior.",
    JSON.stringify({ normalizedKey: candidate.normalizedKey, proposedPackage: candidate.package }),
  ].join("\n\n");
}
function digest(...parts: readonly string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex");
}
function assertRevision(candidate: MemorySkillCandidate, expected: number): void {
  if (candidate.revision !== expected)
    throw Object.assign(new Error("skill_candidate_revision_conflict"), {
      code: "revision_conflict",
    });
}
function validationError(
  diagnostics: readonly {
    readonly path: string;
    readonly code: string;
    readonly message: string;
  }[],
): Error & { code: string; retryable: boolean; validation: { diagnostics: typeof diagnostics } } {
  return Object.assign(
    new Error(
      diagnostics
        .map((item) => `${item.path}: ${item.code}: ${item.message}`)
        .join(" | ")
        .slice(0, 2_000),
    ),
    { code: "invalid_input", retryable: true, validation: { diagnostics } },
  );
}
function revisionJobReadFailureCode(error: unknown): string {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? (error as { readonly code?: unknown }).code
      : undefined;
  if (code === "skill_revision_job_not_found" || code === "ENOENT") {
    return "memory_skill_revision_job_missing";
  }
  if (error instanceof z.ZodError) return "memory_skill_revision_job_invalid";
  return "memory_skill_revision_job_unavailable";
}
async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}
