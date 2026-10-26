import { randomUUID } from "node:crypto";
import { writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  KnowledgeLearningPlanSchema,
  SkillLearningPlanSchema,
  type KnowledgeLearningPlanner,
  type SkillLearningPlanner,
  type LegacyLearningTaskIdentity,
} from "@pragma/memory";
import { extractStructuredJson } from "@pragma/built-in-agents";
import {
  waitForInternalMissionRetry,
  type MissionStore,
  type LocalHostMissionApplication,
} from "@pragma/local-host";
import { createLegacyMemoryRevisionRegistry } from "./legacy-memory-revision-registry.ts";

/** Read-only drain of registered pre-#434 Missions. Never dispatches or corrects a Planner. */
export function createLegacyMemoryRevisionObserver(options: {
  readonly pragmaHome: string;
  readonly missions: MissionStore;
  readonly application: LocalHostMissionApplication;
}) {
  const registry = join(options.pragmaHome, "state", "memory-revision-planning");
  const { find } = createLegacyMemoryRevisionRegistry(options);
  const observe = async (kind: "knowledge" | "skill", digest: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const mission = await find(kind, digest, undefined, true);
    if (mission?.execution === undefined)
      throw Object.assign(new Error("memory_legacy_revision_owner_unconfirmed"), {
        retryable: false,
      });
    if (["running", "queued", "waiting"].includes(mission.execution.status))
      throw new Error("memory_revision_observation_pending");
    if (mission.execution.status !== "succeeded")
      throw Object.assign(new Error("memory_legacy_revision_failed"), { retryable: false });
    for (let attempt = 0; ; attempt++) {
      try {
        const snapshot = await options.application.getInternalConversationSnapshot(mission.id);
        signal.throwIfAborted();
        const content = snapshot.entries
          .filter((entry) => entry.kind === "assistant")
          .filter((entry) => entry.executionId === mission.execution!.id && !entry.streaming)
          .at(-1)?.content;
        if (!content) throw new Error("memory_legacy_revision_result_missing");
        return JSON.parse(extractStructuredJson(content)) as unknown;
      } catch (error) {
        signal.throwIfAborted();
        if (attempt >= 3)
          throw Object.assign(
            new Error("memory_legacy_revision_result_unavailable", { cause: error }),
            { retryable: false },
          );
        await waitForInternalMissionRetry(5000, signal);
      }
    }
  };
  const settle = async (kind: "knowledge" | "skill", digest: string, disposition = "committed") => {
    const mission = await find(kind, digest);
    if (mission === undefined) return;
    const path = join(registry, `${mission.id}.settled`);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(
      temporary,
      JSON.stringify({
        schemaVersion: "pragma.memory-legacy-plan-settlement/v1",
        missionId: mission.id,
        disposition,
      }),
      { mode: 0o600 },
    );
    await rename(temporary, path);
    // A cleanup failure cannot revoke the durable handoff settlement.
    await options.application.delete(mission.id).catch(() => undefined);
  };
  const prepareDirectRetry = async (
    kind: "knowledge" | "skill",
    digest: string,
    task?: LegacyLearningTaskIdentity,
  ) => {
    const mission = await find(kind, digest, task, task === undefined);
    if (
      mission !== undefined &&
      (mission.execution === undefined ||
        !["succeeded", "failed", "cancelled"].includes(mission.execution.status))
    )
      return false;
    await settle(kind, digest, "manual-restart");
    return true;
  };
  return {
    knowledge: {
      hasPending: async (digest, task?: LegacyLearningTaskIdentity) =>
        (await find("knowledge", digest, task)) !== undefined,
      settle: (digest) => settle("knowledge", digest),
      prepareDirectRetry: (digest, task?: LegacyLearningTaskIdentity) =>
        prepareDirectRetry("knowledge", digest, task),
      async plan(input) {
        return KnowledgeLearningPlanSchema.parse(
          await observe("knowledge", input.sourceDigest, input.signal),
        );
      },
    } satisfies KnowledgeLearningPlanner,
    skill: {
      hasPending: async (digest, task?: LegacyLearningTaskIdentity) =>
        (await find("skill", digest, task)) !== undefined,
      settle: (digest) => settle("skill", digest),
      prepareDirectRetry: (digest, task?: LegacyLearningTaskIdentity) =>
        prepareDirectRetry("skill", digest, task),
      async plan(input) {
        return SkillLearningPlanSchema.parse(
          normalizeLegacySkillDescriptions(
            await observe("skill", input.sourceDigest, input.signal),
          ),
        );
      },
    } satisfies SkillLearningPlanner,
  };
}

// Preserve the old Planner's local repair for a supported historical terminal response.
function normalizeLegacySkillDescriptions(value: unknown): unknown {
  if (
    value === null ||
    typeof value !== "object" ||
    !("action" in value) ||
    value.action !== "apply" ||
    !("changes" in value) ||
    !Array.isArray(value.changes)
  )
    return value;
  return {
    ...value,
    changes: value.changes.map((change: unknown) => {
      if (
        change === null ||
        typeof change !== "object" ||
        !("description" in change) ||
        typeof change.description !== "string" ||
        change.description.trim().length <= 500
      )
        return change;
      let prefix = "";
      for (const character of change.description.trim()) {
        if (prefix.length + character.length > 499) break;
        prefix += character;
      }
      const boundary = Math.max(
        ...[...prefix.matchAll(/[。！？]|[.!?](?:\s|$)/gu)].map((match) => match.index! + 1),
        -1,
      );
      return {
        ...change,
        description: boundary >= 120 ? prefix.slice(0, boundary) : prefix.trimEnd() + "…",
      };
    }),
  };
}
