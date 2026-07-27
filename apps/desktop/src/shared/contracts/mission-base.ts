import {
  MissionExecutorRefSchema,
  MissionExecutorSchema,
  type MissionExecutor,
} from "@pragma/shared";
import { PragmaObjectJsonSchemaSchema } from "@pragma/interpreter/ast";
import { z } from "zod";

import { ExpertModelConfigSchema } from "./capabilities.ts";
import { ExpertRefSchema } from "./experts.ts";
import { DesktopToolPermissionModeSchema } from "./settings.ts";

export { MissionExecutorRefSchema, MissionExecutorSchema };
export type { MissionExecutor };

export const MissionIdSchema = z.string().uuid();

export const MissionWorkspaceSchema = z.object({
  path: z.string().trim().min(1).max(2_000),
  basename: z.string().trim().min(1).max(255),
});

const MissionExecutorOptionBaseSchema = z.object({
  ref: MissionExecutorRefSchema,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(2_000),
  origin: z.enum(["project", "built-in"]),
  readOnly: z.boolean(),
  customized: z.boolean(),
});

export const MissionExecutorOptionSchema = z.discriminatedUnion("kind", [
  MissionExecutorOptionBaseSchema.extend({ kind: z.literal("expert") }),
  MissionExecutorOptionBaseSchema.extend({ kind: z.literal("team") }),
  MissionExecutorOptionBaseSchema.extend({
    kind: z.literal("flow"),
    inputSchema: PragmaObjectJsonSchemaSchema.optional(),
  }),
]);

export const MissionCreationDefaultsSchema = z.object({
  workspace: MissionWorkspaceSchema,
  recentWorkspaces: z.array(MissionWorkspaceSchema).max(5),
  executorRef: ExpertRefSchema,
  toolPermissionMode: DesktopToolPermissionModeSchema,
});

export const MissionModelOverrideSchema = ExpertModelConfigSchema.omit({
  runtimeId: true,
}).strict();
