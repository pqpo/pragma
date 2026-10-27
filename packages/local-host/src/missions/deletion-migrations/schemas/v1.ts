import { z } from "zod";
const StepSchema = z
  .object({
    done: z.boolean(),
    attempts: z.number().int().nonnegative(),
    nextAt: z.number().nonnegative(),
    errorCode: z.string().optional(),
  })
  .strict();
export const MissionDeletionRecordV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.mission-deletion/v1"),
    missionId: z.string().min(1),
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
export type MissionDeletionRecordV1 = z.infer<typeof MissionDeletionRecordV1Schema>;
