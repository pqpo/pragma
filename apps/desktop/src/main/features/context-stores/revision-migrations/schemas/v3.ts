import { ContextStoreDraftSchema } from "@pragma/built-in-agents/contracts";
import { z } from "zod";
export const ContextStoreRevisionRequestSchema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-request/v2"),
    operation: z.enum(["revise", "create"]),
    storeId: z.string().uuid(),
    resourceName: z.string().trim().min(1).max(120).optional(),
    resourceDescription: z.string().trim().min(1).max(2_000).optional(),
    prompt: z.string().trim().min(1).max(50_000),
    source: z.enum(["user", "memory-learning", "expert-reflection"]),
    sourceDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .optional(),
    provenance: z
      .object({
        executionId: z.string().min(1).max(200),
        invocationId: z.string().min(1).max(200),
        expertId: z.string().min(1).max(200),
        teamId: z.string().min(1).max(200).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((request, context) => {
    if (
      request.operation === "create" &&
      (request.resourceName === undefined || request.resourceDescription === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resourceName"],
        message: "Creating a knowledge base requires its name and description.",
      });
    }
    if (
      request.operation === "revise" &&
      (request.resourceName !== undefined || request.resourceDescription !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["resourceName"],
        message: "Knowledge-base metadata is only accepted for creation requests.",
      });
    }
    if (request.source !== "user" && request.sourceDigest === undefined) {
      context.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "Machine-submitted revisions require a source digest.",
      });
    }
    if (
      request.source === "user" &&
      (request.sourceDigest !== undefined || request.provenance !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["sourceDigest"],
        message: "User revision requests cannot attach machine provenance.",
      });
    }
    if ((request.source === "expert-reflection") !== (request.provenance !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["provenance"],
        message: "Only expert reflection revisions require execution provenance.",
      });
    }
  });

export const ContextStoreRevisionJobStateSchema = z.enum([
  "editing",
  "running",
  "pending_review",
  "merging",
  "merged",
  "rejected",
  "needs_rebase",
  "needs_attention",
]);

export const ContextStoreRevisionJobV3Schema = z
  .object({
    schemaVersion: z.literal("pragma.context-store-revision-job/v3"),
    id: z.string().uuid(),
    revision: z.number().int().positive(),
    draftId: z.string().uuid(),
    missionId: z.string().uuid().optional(),
    request: ContextStoreRevisionRequestSchema,
    state: ContextStoreRevisionJobStateSchema,
    error: z
      .object({ code: z.string().min(1).max(100), message: z.string().min(1).max(2_000) })
      .strict()
      .optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .strict();

export type ContextStoreRevisionJobV3 = z.infer<typeof ContextStoreRevisionJobV3Schema>;

export const KnowledgeRevisionReworkV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.knowledge-revision-rework/v1"),
    nextDraft: ContextStoreDraftSchema,
    nextJob: ContextStoreRevisionJobV3Schema,
  })
  .strict();
