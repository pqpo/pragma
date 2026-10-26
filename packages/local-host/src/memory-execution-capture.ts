import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { PragmaPaths } from "@pragma/core";
import {
  ContextStoreRevisionJobSchema,
  ManagedSkillRevisionJobSchema,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
} from "@pragma/built-in-agents";
import { MissionSchema, type CanonicalEventEnvelope } from "@pragma/shared";
import { z } from "zod";
import { createMissionDeliveryReceiptStore } from "./mission-delivery-receipt-store.ts";

const LinkSchema = z.object({ mission: MissionSchema });

/** Desktop and CLI share the same capture checkpoint and must apply the same origin guard. */
export async function excludeInternalMemoryExecution(
  event: CanonicalEventEnvelope,
  pragmaHome: string,
): Promise<boolean> {
  const root = event.relatedRefs.find((ref) => ref.relation === "pragma.execution-root")?.ref;
  if (
    root?.type !== "pragma.expert" ||
    ![SKILL_REVISION_EXPERT_REF, STORE_REVISION_EXPERT_REF].some(
      (ref) => ref === `expert:${root.id}`,
    )
  )
    return false;
  try {
    if (event.correlationId === undefined) throw new Error("Execution identity missing");
    const receipts = await createMissionDeliveryReceiptStore({
      path: new PragmaPaths({ pragmaHome }).missionDelivery(),
      onNotice: () => undefined,
    });
    try {
      const link = await receipts.link(event.correlationId);
      if (link === undefined) throw new Error("Mission admission link pending");
      const mission = LinkSchema.parse(JSON.parse(link.payload)).mission;
      if (mission.origin.type === "system-memory") return true;
      // Historical background drafts predate the dedicated immutable Memory origin.
      // Read their authority job; unavailable/old/future data is deferred, never guessed.
      const origin = mission.origin;
      const paths = new PragmaPaths({ pragmaHome });
      if (origin.type === "system-store-revision") {
        const job = ContextStoreRevisionJobSchema.parse(
          JSON.parse(
            await readFile(
              join(paths.stateRoot(), "context-store-revisions", "jobs", `${origin.jobId}.json`),
              "utf8",
            ),
          ),
        );
        if (job.id !== origin.jobId || job.request.storeId !== origin.storeId)
          throw new Error("Memory revision identity mismatch");
        return job.request.source === "memory-learning";
      }
      if (origin.type === "system-skill-revision") {
        const job = ManagedSkillRevisionJobSchema.parse(
          JSON.parse(
            await readFile(
              join(paths.stateRoot(), "skill-revisions", "jobs", `${origin.jobId}.json`),
              "utf8",
            ),
          ),
        );
        if (job.id !== origin.jobId || job.request.capabilityId !== origin.capabilityId)
          throw new Error("Memory revision identity mismatch");
        return job.request.source === "memory-learning";
      }
      return false;
    } finally {
      await receipts.close();
    }
  } catch (cause) {
    throw Object.assign(new Error("memory_execution_origin_unavailable", { cause }), {
      code: "memory_execution_origin_unavailable",
      retryable: true,
    });
  }
}
