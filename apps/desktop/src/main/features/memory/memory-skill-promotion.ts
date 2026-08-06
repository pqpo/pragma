import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { withFileLock } from "@pragma/context-filesystem";
import type {
  ExistingMemorySkillTarget,
  MemorySubjectRef,
  SkillExtractionCandidate,
  SkillPackage,
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
  type SkillEvaluationSnapshot,
  type UpdateMemorySkillCandidate,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { SkillRevisionService } from "../capabilities/skill-revision-service.ts";

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

export interface MemorySkillCandidateEvaluator {
  evaluate(input: {
    readonly candidateId: string;
    readonly package: SkillPackage;
    readonly replayCases: MemorySkillCandidate["replayCases"];
    readonly boundaryCase: MemorySkillCandidate["boundaryCase"];
  }): Promise<SkillEvaluationSnapshot>;
}

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
  retry(input: MemorySkillCandidateRef): Promise<MemorySkillCandidate>;
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
  readonly evaluator: MemorySkillCandidateEvaluator;
  readonly expertExists: (expertRef: string) => Promise<boolean>;
  readonly bindSkill: (expertRef: string, capabilityId: string, revision: number) => Promise<void>;
}): MemorySkillPromotionService {
  const candidatesPath = join(options.statePath, "candidates");
  const bindingsPath = join(options.statePath, "bindings.json");
  const journalPath = join(options.statePath, "promotion.json");
  const lockPath = join(options.statePath, ".lock");
  const candidatePath = (id: string) => join(candidatesPath, `${id}.json`);
  let evaluationQueue: Promise<void> = Promise.resolve();

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
    MemorySkillCandidateSchema.parse(JSON.parse(await readFile(candidatePath(id), "utf8")));
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

  const scheduleEvaluation = (candidateId: string): void => {
    evaluationQueue = evaluationQueue.then(async () => {
      const candidate = await readCandidate(candidateId);
      if (candidate.state !== "evaluating") return;
      try {
        const evaluation = await options.evaluator.evaluate({
          candidateId,
          package: candidate.package,
          replayCases: candidate.replayCases,
          boundaryCase: candidate.boundaryCase,
        });
        await withFileLock(lockPath, async () => {
          const current = await readCandidate(candidateId);
          if (
            current.state !== "evaluating" ||
            current.revision !== candidate.revision ||
            evaluation.subjectHash !== packageHash(current.package)
          )
            return;
          await writeCandidate(
            MemorySkillCandidateSchema.parse({
              ...current,
              revision: current.revision + 1,
              state: evaluation.passed ? "pending_review" : "needs_attention",
              evaluation,
              ...(evaluation.passed
                ? { lastErrorCode: undefined }
                : { lastErrorCode: "skill_evaluation_failed" }),
              updatedAt: new Date().toISOString(),
            }),
          );
        });
      } catch (error) {
        await withFileLock(lockPath, async () => {
          const current = await readCandidate(candidateId);
          if (current.state !== "evaluating" || current.revision !== candidate.revision) return;
          await writeCandidate(
            MemorySkillCandidateSchema.parse({
              ...current,
              revision: current.revision + 1,
              state: "needs_attention",
              lastErrorCode: errorCode(error),
              updatedAt: new Date().toISOString(),
            }),
          );
        });
      }
    });
  };

  const submitRevision = async (
    expertRef: string,
    sourceDigest: string,
    candidate: SkillExtractionCandidate,
    capabilityId: string,
  ) => {
    await options.revisions.submit({
      schemaVersion: "pragma.skill-revision-request/v1",
      capabilityId,
      source: "memory-learning",
      sourceDigest: digest(sourceDigest, candidate.content.normalizedKey),
      sourceRefs: candidate.sourceRefs,
      replayCases: candidate.content.replayCases,
      boundaryCase: candidate.content.boundaryCase,
      prompt: renderRevisionPrompt(candidate),
    });
    await withFileLock(lockPath, async () => {
      const bindings = await readBindings();
      await writeBindings(
        bindings.bindings.map((binding) =>
          binding.expertRef === expertRef && binding.capabilityId === capabilityId
            ? {
                ...binding,
                normalizedKeys: [
                  ...new Set([...binding.normalizedKeys, candidate.content.normalizedKey]),
                ],
                lastSourceDigest: sourceDigest,
                updatedAt: new Date().toISOString(),
              }
            : binding,
        ),
      );
    });
    options.revisions.scheduleProcessing();
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
        const bindings = (await readBindings()).bindings.filter(
          (binding) => binding.expertRef === input.expertRef,
        );
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
          await submitRevision(
            input.expertRef,
            input.sourceDigest,
            extracted,
            binding.capabilityId,
          );
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
        const candidate = await withFileLock(lockPath, async () => {
          const timestamp = new Date().toISOString();
          const existing = (await readCandidates()).find(
            (item) =>
              item.expertRef === input.expertRef &&
              item.normalizedKey === extracted.content.normalizedKey &&
              ["needs_target", "evaluating", "pending_review", "needs_attention"].includes(
                item.state,
              ),
          );
          if (existing?.sourceDigest === input.sourceDigest) return undefined;
          const next = MemorySkillCandidateSchema.parse({
            schemaVersion: "pragma.memory-skill-candidate/v1",
            id: existing?.id ?? randomUUID(),
            revision: (existing?.revision ?? 0) + 1,
            expertRef: input.expertRef,
            sourceDigest: input.sourceDigest,
            normalizedKey: extracted.content.normalizedKey,
            sourceRefs: extracted.sourceRefs,
            package: extracted.content.package,
            replayCases: extracted.content.replayCases,
            boundaryCase: extracted.content.boundaryCase,
            route,
            state: route.type === "needs_target" ? "needs_target" : "evaluating",
            createdAt: existing?.createdAt ?? timestamp,
            updatedAt: timestamp,
          });
          await writeCandidate(next);
          return next;
        });
        if (candidate?.state === "evaluating") scheduleEvaluation(candidate.id);
      }
    },
    async list(input = {}) {
      return (await readCandidates())
        .filter((candidate) => input.state === undefined || candidate.state === input.state)
        .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    },
    async update(rawInput) {
      const input = UpdateMemorySkillCandidateSchema.parse(rawInput);
      const next = await withFileLock(lockPath, async () => {
        const current = await readCandidate(input.id);
        assertRevision(current, input.expectedRevision);
        if (!["pending_review", "needs_attention"].includes(current.state))
          throw new Error("skill_candidate_state_invalid");
        const updated = MemorySkillCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          package: input.package,
          state: "evaluating",
          evaluation: undefined,
          lastErrorCode: undefined,
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(updated);
        return updated;
      });
      scheduleEvaluation(next.id);
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
          await options.revisions.submit({
            schemaVersion: "pragma.skill-revision-request/v1",
            capabilityId: option.capabilityId,
            source: "memory-learning",
            sourceDigest: digest(current.sourceDigest, current.normalizedKey),
            sourceRefs: current.sourceRefs,
            replayCases: current.replayCases,
            boundaryCase: current.boundaryCase,
            prompt: renderCandidateRevisionPrompt(current),
          });
          options.revisions.scheduleProcessing();
          const revised = MemorySkillCandidateSchema.parse({
            ...current,
            revision: current.revision + 1,
            state: "promoted",
            capabilityId: option.capabilityId,
            updatedAt: new Date().toISOString(),
          });
          await writeCandidate(revised);
          return revised;
        }
        const created = MemorySkillCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          route: { type: "create" },
          state: "evaluating",
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(created);
        return created;
      });
      if (next.state === "evaluating") scheduleEvaluation(next.id);
      return next;
    },
    async reject(rawInput) {
      const input = MemorySkillCandidateRefSchema.parse(rawInput);
      return await withFileLock(lockPath, async () => {
        const current = await readCandidate(input.id);
        assertRevision(current, input.expectedRevision);
        if (!["pending_review", "needs_attention", "needs_target"].includes(current.state))
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
        if (
          current.state !== "pending_review" ||
          current.evaluation?.passed !== true ||
          current.evaluation.subjectHash !== packageHash(current.package)
        )
          throw new Error("skill_candidate_not_approved_for_promotion");
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
    async retry(rawInput) {
      const input = MemorySkillCandidateRefSchema.parse(rawInput);
      const next = await withFileLock(lockPath, async () => {
        const current = await readCandidate(input.id);
        assertRevision(current, input.expectedRevision);
        if (current.state !== "needs_attention") throw new Error("skill_candidate_state_invalid");
        const updated = MemorySkillCandidateSchema.parse({
          ...current,
          revision: current.revision + 1,
          state: "evaluating",
          evaluation: undefined,
          lastErrorCode: undefined,
          updatedAt: new Date().toISOString(),
        });
        await writeCandidate(updated);
        return updated;
      });
      scheduleEvaluation(next.id);
      return next;
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
      try {
        const journal = PromotionJournalSchema.parse(
          JSON.parse(await readFile(journalPath, "utf8")),
        );
        await withFileLock(lockPath, async () => await finalizePromotion(journal));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
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
function packageHash(skill: SkillPackage): string {
  return createHash("sha256").update(JSON.stringify(skill)).digest("hex");
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
function errorCode(error: unknown): string {
  return error instanceof Error && /^[a-z0-9_:-]+$/iu.test(error.message)
    ? error.message.slice(0, 100)
    : "skill_evaluation_failed";
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
