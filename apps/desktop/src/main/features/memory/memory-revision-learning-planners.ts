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

import type { MissionRunner } from "../missions/mission-runner.ts";
import { MissionStoreError, type MissionStore } from "../missions/mission-store.ts";
import type { PragmaProjectStore } from "../projects/pragma-project-store.ts";

const MAX_SOURCE_BYTES = 40_000;

export function createMemoryRevisionLearningPlanners(options: {
  readonly pragmaHome: string;
  readonly missions: MissionStore;
  readonly runner: MissionRunner;
  readonly project: PragmaProjectStore;
}): {
  readonly knowledge: KnowledgeLearningPlanner;
  readonly skill: SkillLearningPlanner;
  readonly recoverOrphans: () => Promise<number>;
} {
  const workspace = join(options.pragmaHome, "tmp", "memory-revision-planning");
  const registry = join(options.pragmaHome, "state", "memory-revision-planning");
  const active = new Set<string>();
  const run = async (input: {
    readonly ref: typeof STORE_REVISION_EXPERT_REF | typeof SKILL_REVISION_EXPERT_REF;
    readonly jobId: string;
    readonly goal: string;
    readonly signal: AbortSignal;
  }): Promise<unknown> => {
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
      await options.runner.delete(mission.id).catch(() => undefined);
      throw error;
    }
    const interrupt = (): void => {
      void options.runner.interrupt(mission.id).catch(() => undefined);
    };
    input.signal.addEventListener("abort", interrupt, { once: true });
    try {
      await options.runner.run(mission.id);
      const deadline = Date.now() + 10 * 60_000;
      while (Date.now() < deadline) {
        input.signal.throwIfAborted();
        const current = await options.missions.get(mission.id);
        if (
          current.execution !== undefined &&
          ["succeeded", "failed", "cancelled"].includes(current.execution.status)
        ) {
          if (current.execution.status !== "succeeded") {
            const runtimeFailure = await options.runner.getTerminalRuntimeFailure(mission.id);
            throw Object.assign(
              new Error(
                runtimeFailure?.message ??
                  current.execution.error ??
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
          const chat = await options.runner.getChatPage({ id: mission.id, limit: 50 });
          const content = chat.entries
            .filter((entry) => entry.kind === "assistant")
            .at(-1)?.content;
          if (content === undefined) throw new Error("memory_revision_plan_missing");
          return JSON.parse(extractStructuredJson(content));
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 200));
      }
      throw new Error("memory_revision_planning_timeout");
    } finally {
      input.signal.removeEventListener("abort", interrupt);
      active.delete(mission.id);
      let deleted = false;
      try {
        await options.runner.delete(mission.id);
        deleted = true;
      } catch {
        // The marker keeps an interrupted Mission available for targeted recovery.
      }
      if (deleted) await rm(join(registry, mission.id), { force: true }).catch(() => undefined);
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
          await options.runner.delete(missionId);
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
        const result = await run({
          ref: STORE_REVISION_EXPERT_REF,
          jobId: `knowledge-plan:${input.sourceDigest}`,
          signal: input.signal,
          goal: [
            "Plan a Memory-derived knowledge revision. This is a planning-only run: do not call tools or start a draft.",
            "Decide whether the supplied sources contain reusable, supported knowledge. Historical Episodes are context, not current truth.",
            'Return only {"action":"skip"} or {"action":"apply","name":"...","description":"..."}.',
            "A later run of this same Store Revision Agent will edit the draft after Host authorization.",
            `Root: ${JSON.stringify(input.rootRef)}`,
            `Expert: ${input.expertRef}`,
            `Sources: ${JSON.stringify(sources)}`,
          ].join("\n\n"),
        });
        return KnowledgeLearningPlanSchema.parse(result);
      },
    },
    skill: {
      async plan(input) {
        const sources = boundedSources(input.sources);
        const result = await run({
          ref: SKILL_REVISION_EXPERT_REF,
          jobId: `skill-plan:${input.sourceDigest}`,
          signal: input.signal,
          goal: [
            "Plan Memory-derived Skill creation or revision. This is a planning-only run: do not call tools or start a draft.",
            "Choose at most three complete reusable workflows. Cite exact supplied sourceRefs. Use only supplied existing target IDs.",
            'Return only {"action":"skip"} or {"action":"apply","changes":[{"name":"...","description":"...","normalizedKey":"...","sourceRefs":[{"kind":"episodic","id":"first supplied episode ID","revision":1},{"kind":"episodic","id":"second supplied episode ID","revision":1},{"kind":"episodic","id":"third supplied episode ID","revision":1}],"target":{"type":"create"}}]}. Cite at least three distinct high-value Episodes from two conversations, including two successful or recovered outcomes.',
            'For an existing target use {"type":"revise","capabilityId":"..."}. A later run of this same Skill Revision Agent will edit each draft.',
            `Root: ${JSON.stringify(input.rootRef)}`,
            `Expert: ${input.expertRef}`,
            `Existing targets: ${JSON.stringify(input.existingTargets)}`,
            `Sources: ${JSON.stringify(sources)}`,
          ].join("\n\n"),
        });
        return SkillLearningPlanSchema.parse(result);
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
