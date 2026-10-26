import {
  MEMORY_LEARNING_MAX_INSPECTIONS,
  MEMORY_LEARNING_MAX_INSPECTION_BYTES,
} from "@pragma/shared";
import {
  createLearningInspection,
  LearningInspectionRequestSchema,
} from "./learning-inspection.ts";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { waitForInternalMissionTerminal, waitForInternalMissionRetry } from "@pragma/local-host";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

import {
  extractStructuredJson,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
} from "@pragma/built-in-agents";
import {
  KnowledgeLearningPlanSchema,
  inspectSkillLearningPlan,
  qualifyingSkillLearningPlan,
  SkillLearningPlanSchema,
  type KnowledgeLearningPlan,
  type SkillLearningPlan,
  type KnowledgeLearningPlanner,
  type SkillLearningPlanner,
} from "@pragma/memory";

import type { LocalHostMissionApplication } from "@pragma/local-host";
import { MissionStoreError, type MissionStore } from "@pragma/local-host";
import type { PragmaProjectStore } from "@pragma/local-host/deployment";

const MAX_PLAN_REPAIRS = 2;
const MAX_PLAN_READ_ATTEMPTS = 4;

export function createMemoryRevisionLearningPlanners(options: {
  readonly pragmaHome: string;
  readonly missions: MissionStore;
  readonly application: LocalHostMissionApplication;
  readonly project: PragmaProjectStore;
}): {
  readonly knowledge: KnowledgeLearningPlanner;
  readonly skill: SkillLearningPlanner;
  readonly recoverOrphans: () => Promise<number>;
} {
  const workspace = join(options.pragmaHome, "tmp", "memory-revision-planning");
  const registry = join(options.pragmaHome, "state", "memory-revision-planning");
  const active = new Set<string>();
  const run = async <T>(input: {
    readonly ref: typeof STORE_REVISION_EXPERT_REF | typeof SKILL_REVISION_EXPERT_REF;
    readonly jobId: string;
    readonly goal: string;
    readonly signal: AbortSignal;
    readonly schema: z.ZodType<T>;
    readonly inspection: ReturnType<typeof createLearningInspection>;
    readonly validate?: (
      plan: T,
    ) => readonly { readonly index: number; readonly message: string }[];
    readonly settle?: (plan: T) => T;
  }): Promise<T> => {
    input.signal.throwIfAborted();
    await mkdir(workspace, { recursive: true, mode: 0o700 });
    const project = await options.project.ensurePublished();
    const mission = await options.missions.create({
      workspace: { path: workspace, basename: basename(workspace) },
      goal: input.goal,
      title:
        input.ref === STORE_REVISION_EXPERT_REF ? "Plan Memory knowledge" : "Plan Memory Skill",
      project: { id: project.projectId, revision: project.revision },
      executor: {
        kind: "expert",
        ref: input.ref,
        name:
          input.ref === STORE_REVISION_EXPERT_REF ? "Store Revision Agent" : "Skill Revision Agent",
      },
      origin: { type: "system-memory", jobId: input.jobId },
    });
    try {
      await mkdir(registry, { recursive: true, mode: 0o700 });
      await writeFile(join(registry, mission.id), "", { flag: "wx", mode: 0o600 });
      active.add(mission.id);
    } catch (error) {
      await options.application.delete(mission.id).catch(() => undefined);
      throw error;
    }
    const interrupt = (): void => {
      void options.application.interrupt(mission.id).catch(() => undefined);
    };
    input.signal.addEventListener("abort", interrupt, { once: true });
    try {
      await options.application.startRun(mission.id);
      let executionId: string | undefined;
      let repairs = 0;
      let inspections = 0;
      let deliveredBytes = 0;
      for (;;) {
        const current = await waitForInternalMissionTerminal({
          executionId,
          getMission: (id) => options.missions.get(id),
          missionId: mission.id,
          signal: input.signal,
          timeoutMessage: "memory_revision_planning_timeout",
        }).catch((cause: unknown) => {
          // A lost terminal observation cannot authorize another paid Mission.
          throw planningObservationError(cause);
        });
        if (current.execution!.status === "cancelled") {
          throw Object.assign(new Error("memory_revision_planning_cancelled"), {
            retryable: false,
          });
        }
        if (current.execution!.status !== "succeeded") {
          const runtimeFailure = await options.application
            .getTerminalRuntimeFailure(mission.id)
            .catch((cause: unknown) => {
              throw planningObservationError(cause);
            });
          throw Object.assign(
            new Error(
              runtimeFailure?.message ??
                current.execution!.error ??
                "memory_revision_planning_failed",
            ),
            {
              code: runtimeFailure?.code ?? "memory_revision_planning_failed",
              retryable: runtimeFailure?.retryable ?? true,
              ...(runtimeFailure?.httpStatus === undefined
                ? {}
                : { httpStatus: runtimeFailure.httpStatus }),
              ...(runtimeFailure?.requestId === undefined
                ? {}
                : { requestId: runtimeFailure.requestId }),
              ...(runtimeFailure?.endpoint === undefined
                ? {}
                : { endpoint: runtimeFailure.endpoint }),
            },
          );
        }
        const content = await readPlanContent(mission.id, current.execution!.id, input.signal);
        let correction: string;
        let inspectionResponse: string | undefined;
        try {
          input.signal.throwIfAborted();
          const value: unknown = JSON.parse(extractStructuredJson(content));
          const request = LearningInspectionRequestSchema.safeParse(value);
          if (
            !request.success &&
            value !== null &&
            typeof value === "object" &&
            "action" in value &&
            value.action === "inspect"
          )
            throw request.error;
          if (request.success) {
            if (++inspections > MEMORY_LEARNING_MAX_INSPECTIONS)
              throw Object.assign(new Error("memory_learning_inspection_budget_exhausted"), {
                retryable: false,
              });
            const result = await input.inspection.read(request.data);
            inspectionResponse = JSON.stringify({
              inspection: JSON.parse(result),
              remainingRequests: MEMORY_LEARNING_MAX_INSPECTIONS - inspections,
              remainingBytes: Math.max(
                0,
                MEMORY_LEARNING_MAX_INSPECTION_BYTES -
                  deliveredBytes -
                  Buffer.byteLength(result) -
                  256,
              ),
            });
            deliveredBytes += Buffer.byteLength(inspectionResponse);
            if (deliveredBytes > MEMORY_LEARNING_MAX_INSPECTION_BYTES)
              throw Object.assign(new Error("memory_learning_inspection_budget_exhausted"), {
                retryable: false,
              });
            correction = "";
          } else {
            const plan = input.schema.parse(value);
            const issues = input.validate?.(plan) ?? [];
            if (issues.length > 0) {
              if (repairs >= MAX_PLAN_REPAIRS && input.settle !== undefined) {
                const settled = input.settle(plan);
                input.inspection.validate(settled as KnowledgeLearningPlan | SkillLearningPlan);
                return settled;
              }
              throw new z.ZodError(
                issues.map(({ index, message }) => ({
                  code: "custom",
                  path: ["changes", index],
                  message,
                })),
              );
            }
            input.inspection.validate(plan as KnowledgeLearningPlan | SkillLearningPlan);
            return plan;
          }
        } catch (error) {
          if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw error;
          if (repairs++ >= MAX_PLAN_REPAIRS) {
            throw Object.assign(error, { retryable: false });
          }
          correction =
            error instanceof z.ZodError
              ? JSON.stringify(error.issues.map(({ path, message }) => ({ path, message }))).slice(
                  0,
                  4_000,
                )
              : "The response is not valid JSON. Return only the requested JSON object.";
        }
        if (inspectionResponse === undefined)
          await waitForInternalMissionRetry(5_000, input.signal);
        input.signal.throwIfAborted();
        const continued = await options.application
          .continueInternalMemoryMission({
            id: mission.id,
            previousExecutionId: current.execution!.id,
            requestId: randomUUID(),
            content:
              inspectionResponse ??
              [
                "Correct the previous planning response in this same conversation. Do not call tools or start a draft.",
                'Return the entire corrected JSON plan, retaining supported changes. Do not invent sources; remove unsupported changes or return {"action":"skip"} when none qualify.',
                `Validation errors: ${correction}`,
              ].join("\n\n"),
          })
          .catch((error: unknown) => {
            // Dispatch may have reached the Runtime. Never replace an uncertain repair
            // with a fresh paid planning Mission through the outer retry policy.
            throw Object.assign(error instanceof Error ? error : new Error(String(error)), {
              retryable: false,
            });
          });
        executionId = continued.executionId;
      }
    } finally {
      input.signal.removeEventListener("abort", interrupt);
      active.delete(mission.id);
      let deleted = false;
      try {
        await options.application.delete(mission.id);
        deleted = true;
      } catch {
        // The marker keeps an interrupted Mission available for targeted recovery.
      }
      if (deleted) await rm(join(registry, mission.id), { force: true }).catch(() => undefined);
    }
  };

  const readPlanContent = async (
    missionId: string,
    executionId: string,
    signal: AbortSignal,
  ): Promise<string> => {
    for (let attempt = 1; ; attempt += 1) {
      signal.throwIfAborted();
      try {
        const chat = await options.application.getInternalConversationSnapshot(missionId);
        signal.throwIfAborted();
        const content = chat.entries
          .filter((entry) => entry.kind === "assistant")
          .filter((entry) => entry.executionId === executionId && !entry.streaming)
          .at(-1)?.content;
        if (content === undefined || content.trim() === "")
          throw new Error("memory_revision_plan_missing");
        return content;
      } catch (cause) {
        signal.throwIfAborted();
        if (attempt >= MAX_PLAN_READ_ATTEMPTS) {
          throw Object.assign(new Error("memory_revision_plan_read_failed", { cause }), {
            code: "memory_revision_plan_read_failed",
            retryable: false,
          });
        }
        await waitForInternalMissionRetry(5_000, signal);
      }
    }
  };

  return {
    async recoverOrphans() {
      let recovered = 0;
      for (const missionId of await readdir(registry).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      })) {
        if (!/^[0-9a-f-]{36}$/u.test(missionId)) continue;
        if (active.has(missionId)) continue;
        try {
          await options.application.delete(missionId);
        } catch (error) {
          if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found") {
            throw error;
          }
        }
        await rm(join(registry, missionId), { force: true });
        recovered += 1;
      }
      return recovered;
    },
    knowledge: {
      async plan(input) {
        const inspection = createLearningInspection(
          input.sources,
          input.existingTargets,
          input.readTarget === undefined
            ? undefined
            : (target) => input.readTarget!(target as (typeof input.existingTargets)[number]),
        );
        return await run({
          schema: KnowledgeLearningPlanSchema,
          ref: STORE_REVISION_EXPERT_REF,
          jobId: `knowledge-plan:${input.sourceDigest}`,
          signal: input.signal,
          inspection,
          goal: [
            "Plan one valuable incremental knowledge change. Planning only: do not call tools or start a draft. Use inspection JSON requests as needed to read supplied data in this same conversation.",
            "Prefer related mounted knowledge bases, then other editable bases. Compare their contents. Reuse an existing base whenever its scope fits; do not create a base just because an expert lacks a Memory binding. Preserve unrelated content.",
            "Knowledge bases should organize stable domain or project definitions, invariants, reference material and durable constraints. Do not create a separate base solely to restate one task report or an executable workflow; complete repeatable procedures belong in Skills.",
            "Skip duplicates, temporary task state, logs, unsupported conclusions and trivial facts. Accumulate useful but immature fragments in Memory. Evidence reliability alone does not justify a knowledge base. Historical Episodes are context, not current universal truth.",
            "Create only when no existing target fits AND the topic has a clear durable purpose and independently useful coherent content, supported across two distinct conversations OR a complete explicitly validated successful artifact. One verified Fact alone is insufficient. Do not invent validation or infer universal truth from success.",
            "Apply only a specific useful addition, correction, consolidation or supported removal of obsolete claims. Explain the actual delta compared with the target. With new evidence, improve the existing asset rather than regenerate it.",
            'Return {"action":"skip","disposition":"accumulate|duplicate|unsupported","reason":"..."} or {"action":"apply","name":"1–120 chars","description":"1–2000 chars","rationale":"specific supported delta, 1–2000 chars","sourceRefs":[{"kind":"episodic|semantic","id":"supplied ID","revision":1}],"maturity":"incremental|cross-conversation|validated-artifact","target":{"type":"revise","storeId":"supplied ID","baseRevision":1,"snapshotHash":"supplied hash"}}. For create use target={"type":"create","justification":"why none of the existing bases fits and why this topic is mature"}; maturity must be cross-conversation or validated-artifact. Cite 1–20 distinct supplied sources, fully read before citing.',
            'If the relevant target is pending review, do not create a duplicate or revise an unpublished target. Return {"action":"skip","disposition":"accumulate","reason":"waiting for related review","waitForTarget":"exact supplied pending target ID"}; the Host will resume this work after settlement.',
            inspection.catalog,
            `Root: ${JSON.stringify(input.rootRef)}; Expert: ${input.expertRef}`,
          ].join("\n\n"),
        });
      },
    },
    skill: {
      async plan(input) {
        const inspection = createLearningInspection(
          input.sources,
          input.existingTargets,
          input.readTarget === undefined
            ? undefined
            : (target) => input.readTarget!(target as (typeof input.existingTargets)[number]),
          input.readTargetFile === undefined
            ? undefined
            : (target, path) =>
                input.readTargetFile!(target as (typeof input.existingTargets)[number], path),
        );
        return await run({
          schema: SkillLearningPlanSchema,
          validate: (plan) => inspectSkillLearningPlan(plan, input.sources, input.existingTargets),
          settle: (plan) => {
            input.onRejectedChanges?.(
              inspectSkillLearningPlan(plan, input.sources, input.existingTargets),
            );
            return qualifyingSkillLearningPlan(plan, input.sources, input.existingTargets);
          },
          ref: SKILL_REVISION_EXPERT_REF,
          jobId: `skill-plan:${input.sourceDigest}`,
          signal: input.signal,
          inspection,
          goal: [
            "Plan one to three complete reusable workflows, or skip. Planning only: do not call tools or start a draft. Use inspection JSON requests as needed in this same conversation.",
            "Inspect existing targets and prefer revising a related mounted Skill, then another editable Skill. Read its full content and propose a real improvement; skip duplicates. Use only supplied target identities and current baseRevision/contentHash.",
            "One successfully validated complete workflow can qualify. Multiple independent experiences can also jointly establish a workflow. Episode valueScore is a ranking hint, never an admission requirement. Supporting Facts cannot replace executed workflow evidence. Cite at least one successfully completed Episode for EACH proposal; do not claim a recovery succeeded merely because recovery text exists.",
            "Each workflow must retain a useful purpose after replacing task-specific names, paths and data. It needs applicability, inputs/preconditions, complete ordered steps, actual result verification, and supported limitations or failure handling. Reject single commands, vague advice, incomplete steps or invented validation. Read complete sources including their verification sections.",
            'Return {"action":"skip","disposition":"accumulate|duplicate|unsupported","reason":"..."} or {"action":"apply","changes":[{"name":"1–120 chars","description":"concise summary, 1–500 chars","normalizedKey":"1–300 lowercase ASCII chars matching ^[a-z0-9][a-z0-9._:/-]*$","sourceRefs":[{"kind":"episodic","id":"supplied ID","revision":1}],"target":{"type":"create"}}]}. Cite 1–8 distinct fully read supplied sources per change. All keys must be distinct. Before revising a Skill, understand its package layout and the scripts/references relevant to the proposed change. Record relevant files in targetFiles=["SKILL.md","scripts/relevant-file"]. Use the read mechanisms available in this planning conversation to understand target contents. For revise use target={"type":"revise","capabilityId":"supplied ID","baseRevision":1,"contentHash":"supplied hash"}.',
            'If the relevant target is pending review, do not create a duplicate or revise an unpublished target. Return {"action":"skip","disposition":"accumulate","reason":"waiting for related review","waitForTarget":"exact supplied pending target ID"}; the Host will resume this work after settlement.',
            inspection.catalog,
            `Root: ${JSON.stringify(input.rootRef)}; Expert: ${input.expertRef}`,
          ].join("\n\n"),
        });
      },
    },
  };
}

function planningObservationError(cause: unknown): Error {
  return Object.assign(new Error("memory_revision_planning_observation_failed", { cause }), {
    code: "memory_revision_planning_observation_failed",
    retryable: false,
  });
}
