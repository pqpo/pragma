import { randomUUID } from "node:crypto";
import { readdir, readFile, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import {
  KnowledgeLearningPlanSchema,
  SkillLearningPlanSchema,
  type KnowledgeLearningPlanner,
  type SkillLearningPlanner,
} from "@pragma/memory";
import { extractStructuredJson } from "@pragma/built-in-agents";
import {
  MissionStoreError,
  waitForInternalMissionRetry,
  type MissionStore,
  type LocalHostMissionApplication,
} from "@pragma/local-host";
import { isMemoryRevisionPlanningRun } from "./memory-revision-planning-resource.ts";

/** Read-only drain of registered pre-#434 Missions. Never dispatches or corrects a Planner. */
export function createLegacyMemoryRevisionObserver(options: {
  readonly pragmaHome: string;
  readonly missions: MissionStore;
  readonly application: LocalHostMissionApplication;
}) {
  const registry = join(options.pragmaHome, "state", "memory-revision-planning");
  const find = async (kind: "knowledge" | "skill", digest: string) => {
    let ids: string[];
    try {
      ids = await readdir(join(options.pragmaHome, "state", "memory-revision-planning"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    for (const id of ids.filter((id) => /^[0-9a-f-]{36}$/u.test(id))) {
      try {
        try {
          const settled = JSON.parse(await readFile(join(registry, `${id}.settled`), "utf8")) as {
            schemaVersion?: string;
            missionId?: string;
          };
          if (
            settled.schemaVersion !== "pragma.memory-legacy-plan-settlement/v1" ||
            settled.missionId !== id
          )
            throw new Error("memory_legacy_revision_settlement_invalid");
          continue;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        const mission = await options.missions.get(id);
        if (
          isMemoryRevisionPlanningRun(mission.origin, mission.executor.ref) &&
          mission.origin.type === "system-memory" &&
          mission.origin.jobId === `${kind}-plan:${digest}`
        )
          return mission;
      } catch (error) {
        if (!(error instanceof MissionStoreError) || error.code !== "mission_not_found")
          throw error;
        // A missing registered Mission has an unknown outcome; it does not authorize replacement.
        throw Object.assign(new Error("memory_legacy_revision_owner_missing"), {
          retryable: false,
        });
      }
    }
    return undefined;
  };
  const observe = async (kind: "knowledge" | "skill", digest: string, signal: AbortSignal) => {
    signal.throwIfAborted();
    const mission = await find(kind, digest);
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
  const prepareDirectRetry = async (kind: "knowledge" | "skill", digest: string) => {
    const mission = await find(kind, digest);
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
      hasPending: async (digest) => (await find("knowledge", digest)) !== undefined,
      settle: (digest) => settle("knowledge", digest),
      prepareDirectRetry: (digest) => prepareDirectRetry("knowledge", digest),
      async plan(input) {
        return KnowledgeLearningPlanSchema.parse(
          await observe("knowledge", input.sourceDigest, input.signal),
        );
      },
    } satisfies KnowledgeLearningPlanner,
    skill: {
      hasPending: async (digest) => (await find("skill", digest)) !== undefined,
      settle: (digest) => settle("skill", digest),
      prepareDirectRetry: (digest) => prepareDirectRetry("skill", digest),
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
