import { z } from "zod";
const StepSchema = z
  .object({
    done: z.boolean(),
    attempts: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
    nextAt: z.number().nonnegative(),
    errorCode: z.string().optional(),
  })
  .strict();
export const MissionDeletionRecordV2Schema = z
  .object({
    schemaVersion: z.literal("pragma.mission-deletion/v2"),
    missionId: z.string().min(1),
    retryAttempts: z.number().int().nonnegative(),
    deletionId: z.string().uuid(),
    phase: z.enum(["prepared", "committed", "completed"]),
    executionIds: z.array(z.string().min(1)),
    payload: z.record(z.string(), z.unknown()),
    missionPath: z.string().optional(),
    steps: z
      .object({
        usage: StepSchema,
        memory: StepSchema,
        drafts: StepSchema,
        claims: StepSchema,
        settlement: StepSchema,
      })
      .strict(),
    createdAt: z.string().datetime(),
  })
  .strict();
export type MissionDeletionRecordV2 = z.infer<typeof MissionDeletionRecordV2Schema>;
