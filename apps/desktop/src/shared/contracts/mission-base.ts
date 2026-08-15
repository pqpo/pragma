import {
  MissionExecutorRefSchema,
  MissionExecutorSchema,
  type MissionExecutor,
} from "@pragma/shared";
import { PragmaObjectJsonSchemaSchema } from "@pragma/interpreter/ast";
import { z } from "zod";
import {
  DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
  DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID,
  PragmaAvatarIdSchema,
} from "@pragma/shared";

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
  MissionExecutorOptionBaseSchema.extend({
    kind: z.literal("expert"),
    avatarId: PragmaAvatarIdSchema.default(DEFAULT_PRAGMA_EXPERT_AVATAR_ID),
  }),
  MissionExecutorOptionBaseSchema.extend({
    kind: z.literal("team"),
    avatarId: PragmaAvatarIdSchema.default(DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID),
  }),
  MissionExecutorOptionBaseSchema.extend({
    kind: z.literal("flow"),
    inputSchema: PragmaObjectJsonSchemaSchema.optional(),
  }),
]);

export const HomeExecutorFavoriteScopeSchema = z.enum(["none", "workspace", "global"]);

export const HomeExecutorPreferenceSchema = z.object({
  favoriteScope: HomeExecutorFavoriteScopeSchema,
  hidden: z.boolean(),
  favoriteWorkspace: MissionWorkspaceSchema.optional(),
  favoriteRank: z.number().int().nonnegative().max(4_999).optional(),
  lastWorkspace: MissionWorkspaceSchema.optional(),
  lastUsedAt: z.string().datetime().optional(),
});

export const HomeMissionExecutorOptionSchema = z.intersection(
  MissionExecutorOptionSchema,
  z.object({
    tags: z.array(z.string().trim().min(1).max(100)).max(30),
    teamMemberships: z
      .array(
        z.object({
          ref: MissionExecutorRefSchema,
          name: z.string().trim().min(1).max(120),
        }),
      )
      .max(100),
    preference: HomeExecutorPreferenceSchema,
    alwaysVisible: z.boolean(),
  }),
);

export const MissionCreationDefaultsSchema = z.object({
  workspace: MissionWorkspaceSchema,
  recentWorkspaces: z.array(MissionWorkspaceSchema).max(10),
  executorRef: ExpertRefSchema,
  toolPermissionMode: DesktopToolPermissionModeSchema,
});

export const HomeMissionExecutorCatalogSchema = z.object({
  executors: z.array(HomeMissionExecutorOptionSchema),
  defaults: MissionCreationDefaultsSchema,
});

export const UpdateHomeExecutorPreferenceSchema = z
  .object({
    ref: MissionExecutorRefSchema,
    favoriteScope: HomeExecutorFavoriteScopeSchema.optional(),
    hidden: z.boolean().optional(),
    favoriteWorkspace: z.string().trim().min(1).max(2_000).optional(),
    favoriteRank: z.number().int().nonnegative().max(4_999).optional(),
    clearLastWorkspace: z.boolean().optional(),
  })
  .superRefine((input, context) => {
    if (
      input.favoriteScope === undefined &&
      input.hidden === undefined &&
      input.favoriteRank === undefined &&
      input.clearLastWorkspace !== true
    ) {
      context.addIssue({
        code: "custom",
        message: "At least one Home executor preference change is required.",
      });
    }
    if (input.favoriteScope === "workspace" && input.favoriteWorkspace === undefined) {
      context.addIssue({
        code: "custom",
        path: ["favoriteWorkspace"],
        message: "A workspace favorite requires a favorite workspace.",
      });
    }
    if (input.favoriteWorkspace !== undefined && input.favoriteScope !== "workspace") {
      context.addIssue({
        code: "custom",
        path: ["favoriteWorkspace"],
        message: "A favorite workspace can only be set for a workspace favorite.",
      });
    }
    if (
      input.hidden === true &&
      input.favoriteScope !== undefined &&
      input.favoriteScope !== "none"
    ) {
      context.addIssue({
        code: "custom",
        path: ["favoriteScope"],
        message: "A hidden Home executor cannot also be favorited.",
      });
    }
  });

export const MissionModelOverrideSchema = ExpertModelConfigSchema.omit({
  runtimeId: true,
}).strict();
