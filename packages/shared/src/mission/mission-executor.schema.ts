import { z } from "zod";

const MISSION_EXECUTOR_REF_ID = "[0-9a-hjkmnp-tv-z]{16}";

export const MissionExecutorKindSchema = z.enum(["expert", "team", "flow"]);

export const MissionExecutorRefSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^(expert|team|flow):${MISSION_EXECUTOR_REF_ID}$`, "i"),
    "Expected a Mission executor reference such as expert:7k2m9q4v8np6r3dt.",
  );

const MissionExecutorBaseSchema = z.object({
  ref: MissionExecutorRefSchema,
  name: z.string().trim().min(1).max(120),
});

export const MissionExecutorSchema = z.discriminatedUnion("kind", [
  MissionExecutorBaseSchema.extend({ kind: z.literal("expert") }),
  MissionExecutorBaseSchema.extend({ kind: z.literal("team") }),
  MissionExecutorBaseSchema.extend({ kind: z.literal("flow") }),
]);

export type MissionExecutorKind = z.infer<typeof MissionExecutorKindSchema>;
export type MissionExecutorRef = z.infer<typeof MissionExecutorRefSchema>;
export type MissionExecutor = z.infer<typeof MissionExecutorSchema>;
