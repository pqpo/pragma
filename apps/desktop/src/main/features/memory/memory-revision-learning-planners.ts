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
  SkillLearningPlanSchema,
  type KnowledgeLearningPlanner,
  type SkillLearningPlanner,
} from "@pragma/memory";
import type { KnowledgeSourceSnapshot, SkillSourceSnapshot } from "@pragma/shared";

import type { LocalHostMissionApplication } from "@pragma/local-host";
import { MissionStoreError, type MissionStore } from "@pragma/local-host";
import type { PragmaProjectStore } from "@pragma/local-host/deployment";

const MAX_SOURCE_BYTES = 40_000;
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
      toolPermissionMode: "request-approval",
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
      for (let repair = 0; ; repair += 1) {
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
        try {
          input.signal.throwIfAborted();
          return input.schema.parse(JSON.parse(extractStructuredJson(content)));
        } catch (error) {
          if (!(error instanceof z.ZodError) && !(error instanceof SyntaxError)) throw error;
          if (repair >= MAX_PLAN_REPAIRS) {
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
        await waitForInternalMissionRetry(5_000, input.signal);
        input.signal.throwIfAborted();
        const continued = await options.application
          .continueInternalMemoryMission({
            id: mission.id,
            previousExecutionId: current.execution!.id,
            requestId: randomUUID(),
            content: [
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
        const sources = boundedSources(input.sources);
        return await run({
          schema: KnowledgeLearningPlanSchema,
          ref: STORE_REVISION_EXPERT_REF,
          jobId: `knowledge-plan:${input.sourceDigest}`,
          signal: input.signal,
          goal: [
            "Plan a Memory-derived knowledge revision. This is a planning-only run: do not call tools or start a draft.",
            "Decide whether the supplied sources contain reusable, supported knowledge. Historical Episodes are context, not current truth.",
            'Return only {"action":"skip"} or {"action":"apply","name":"...","description":"..."}.',
            "Use a nonempty name of at most 120 characters and a nonempty description of at most 2000 characters.",
            "A later run of this same Store Revision Agent will edit the draft after Host authorization.",
            `Root: ${JSON.stringify(input.rootRef)}`,
            `Expert: ${input.expertRef}`,
            `Sources: ${JSON.stringify(sources)}`,
          ].join("\n\n"),
        });
      },
    },
    skill: {
      async plan(input) {
        const sources = boundedSources(input.sources);
        return await run({
          schema: SkillLearningPlanSchema,
          ref: SKILL_REVISION_EXPERT_REF,
          jobId: `skill-plan:${input.sourceDigest}`,
          signal: input.signal,
          goal: [
            "Plan Memory-derived Skill creation or revision. This is a planning-only run: do not call tools or start a draft.",
            "Choose one to three complete reusable workflows, or skip when no workflow qualifies. Cite exact supplied sourceRefs. Use only supplied existing target IDs.",
            "For EACH change: name must be 1–120 characters; description must be a concise summary of 1–500 characters, not the workflow body; normalizedKey must be 1–300 lowercase ASCII characters matching ^[a-z0-9][a-z0-9._:/-]*$; sourceRefs must contain 3–8 distinct supplied references. All normalizedKeys must be distinct.",
            'Return only {"action":"skip"} or {"action":"apply","changes":[{"name":"...","description":"...","normalizedKey":"...","sourceRefs":[{"kind":"episodic","id":"first supplied episode ID","revision":1},{"kind":"episodic","id":"second supplied episode ID","revision":1},{"kind":"episodic","id":"third supplied episode ID","revision":1}],"target":{"type":"create"}}]}. Cite at least three distinct high-value Episodes from two conversations, including two successful or recovered outcomes.',
            'For an existing target use {"type":"revise","capabilityId":"..."}. A later run of this same Skill Revision Agent will edit each draft.',
            `Root: ${JSON.stringify(input.rootRef)}`,
            `Expert: ${input.expertRef}`,
            `Existing targets: ${JSON.stringify(input.existingTargets)}`,
            `Sources: ${JSON.stringify(sources)}`,
          ].join("\n\n"),
        });
      },
    },
  };
}

function boundedSources<T extends KnowledgeSourceSnapshot | SkillSourceSnapshot>(
  sources: readonly T[],
): readonly T[] {
  const selected: T[] = [];
  for (const source of sources) {
    const compact = {
      ...source,
      body: source.body.slice(0, 1_500),
      sourceExecutionIds: source.sourceExecutionIds.slice(0, 5),
      producerRefs: source.producerRefs.slice(0, 5),
    } as T;
    if (Buffer.byteLength(JSON.stringify([...selected, compact]), "utf8") > MAX_SOURCE_BYTES) break;
    selected.push(compact);
  }
  return selected;
}

function planningObservationError(cause: unknown): Error {
  return Object.assign(new Error("memory_revision_planning_observation_failed", { cause }), {
    code: "memory_revision_planning_observation_failed",
    retryable: false,
  });
}
