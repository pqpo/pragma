import { z } from "zod";

import { ExpertModelConfigSchema } from "./capabilities.ts";
import { ContextStoreChangeSetSchema, ContextStoreIdSchema } from "./context-stores.ts";

export const ContextStoreRevisionRequestSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-request/v1"),
    storeId: ContextStoreIdSchema,
    prompt: z.string().trim().min(1).max(50_000),
    source: z.enum(["user", "memory-learning"]),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (request.source === "memory-learning" && request.sourceDigest === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "Memory learning revisions require a source digest.",
      });
    }
    if (request.source === "user" && request.sourceDigest !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "User revision requests cannot attach a Memory source digest.",
      });
    }
  });

export const ContextStoreRevisionJobStateSchema = z.enum([
  "pending",
  "running",
  "pending_review",
  "applying",
  "completed",
  "rejected",
  "needs_attention",
  "superseded",
]);

export const ContextStoreRevisionJobSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-job/v1"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    request: ContextStoreRevisionRequestSchema,
    state: ContextStoreRevisionJobStateSchema,
    changeSet: ContextStoreChangeSetSchema.optional(),
    supersededBy: z.string().uuid().optional(),
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export const ListContextStoreRevisionJobsSchema = z
  .object({
    storeId: ContextStoreIdSchema.optional(),
    state: ContextStoreRevisionJobStateSchema.optional(),
  })
  .strict();

export const ContextStoreRevisionJobRefSchema = z
  .object({ jobId: z.string().uuid(), expectedRevision: z.number().int().positive() })
  .strict();

export const ContextStoreRevisionProfileSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-profile/v1"),
    revision: z.number().int().nonnegative(),
    mode: z.enum(["inherit-default", "pinned"]),
    model: ExpertModelConfigSchema.optional(),
    updatedAt: z.string().datetime(),
  })
  .strict()
  .superRefine((profile, context) => {
    if (profile.mode === "pinned" && profile.model === undefined) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "Pinned profile needs a model.",
      });
    }
    if (profile.mode === "inherit-default" && profile.model !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["model"],
        message: "Inherited profile cannot pin a model.",
      });
    }
  });

export const UpdateContextStoreRevisionProfileSchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    mode: z.enum(["inherit-default", "pinned"]),
    model: ExpertModelConfigSchema.optional(),
  })
  .strict();
