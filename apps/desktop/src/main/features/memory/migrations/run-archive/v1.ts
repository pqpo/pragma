import { z } from "zod";
import { MemoryExtractionFailureDiagnosticSchema } from "@pragma/shared";
import { MissionConversationSnapshotSchema } from "../../../../../shared/contracts/missions.ts";
export const MemoryExtractionRunV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.desktop-memory-extraction-run/v1"),
    runId: z.string().uuid(),
    missionId: z.string().uuid(),
    module: z.enum(["episodic", "semantic", "knowledge", "skill"]),
    jobId: z.string().min(1),
    status: z.enum(["running", "succeeded", "failed", "cancelled"]),
    startedAt: z.string().datetime(),
    finishedAt: z.string().datetime().optional(),
    runtimeId: z.string().min(1),
    providerId: z.string().min(1).optional(),
    modelId: z.string().min(1).optional(),
    failure: MemoryExtractionFailureDiagnosticSchema.optional(),
    chat: MissionConversationSnapshotSchema.optional(),
  })
  .strict();
