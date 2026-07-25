import { ExecutionStatusSchema } from "@pragma/shared";
import { z } from "zod";

export const RuntimeContextRecordV4Schema = z.object({
  schemaVersion: z.literal("pragma.runtime-context/v4"),
  contextId: z.string().min(1),
  owner: z.object({
    type: z.enum(["flow-execution", "expert-session"]),
    ownerId: z.string().min(1),
  }),
  origin: z.discriminatedUnion("type", [
    z.object({ type: z.literal("expert-session"), sessionId: z.string().min(1) }),
    z.object({ type: z.literal("invocation"), invocationId: z.string().min(1) }),
  ]),
  expert: z.object({
    id: z.string().min(1),
    version: z.string().min(1),
  }),
  runtime: z.object({
    runtimeId: z.string().min(1),
    revision: z.number().int().positive(),
    fingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  modelSelection: z
    .object({
      model: z.object({
        providerId: z.string().trim().min(1),
        modelId: z.string().trim().min(1),
      }),
      thinkingLevel: z.string().trim().min(1).optional(),
    })
    .optional(),
  snapshot: z
    .object({
      systemSessionId: z.string().min(1),
      runtimeSession: z.object({ type: z.string().min(1), id: z.string().min(1) }),
    })
    .optional(),
  lifecycle: z.enum(["open", "closed"]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  closedAt: z.string().datetime().optional(),
});

export const ExpertSessionRecordV4Schema = z
  .object({
    schemaVersion: z.literal("pragma.expert-session/v4"),
    sessionId: z.string().min(1),
    expertId: z.string().min(1),
    expertVersion: z.string().min(1),
    definitionFingerprint: z.string().length(64),
    status: z.enum(["open", "closed"]),
    activeExecutionId: z.string().min(1).optional(),
    queuedRequestIds: z.array(z.string().min(1)),
    executionIds: z.array(z.string().min(1)),
    rootContextId: z.string().min(1),
    contexts: z.record(z.string(), RuntimeContextRecordV4Schema),
    lastStatus: ExecutionStatusSchema.optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
  })
  .superRefine((value, context) => {
    for (const [contextId, runtimeContext] of Object.entries(value.contexts)) {
      if (runtimeContext.contextId !== contextId) {
        context.addIssue({
          code: "custom",
          path: ["contexts", contextId],
          message: "ExpertSession Context key must match contextId.",
        });
      }
      if (
        runtimeContext.owner.type !== "expert-session" ||
        runtimeContext.owner.ownerId !== value.sessionId
      ) {
        context.addIssue({
          code: "custom",
          path: ["contexts", contextId, "owner"],
          message: "ExpertSession Context owner must match the Session.",
        });
      }
      if (contextId !== value.rootContextId && runtimeContext.origin.type !== "invocation") {
        context.addIssue({
          code: "custom",
          path: ["contexts", contextId, "origin"],
          message: "Delegated ExpertSession Context requires an Invocation origin.",
        });
      }
    }
    const root = value.contexts[value.rootContextId];
    if (root === undefined) {
      context.addIssue({
        code: "custom",
        path: ["rootContextId"],
        message: "ExpertSession root Context is missing.",
      });
      return;
    }
    if (
      root.owner.type !== "expert-session" ||
      root.owner.ownerId !== value.sessionId ||
      root.origin.type !== "expert-session" ||
      root.origin.sessionId !== value.sessionId
    ) {
      context.addIssue({
        code: "custom",
        path: ["rootContextId"],
        message: "ExpertSession root Context identity is invalid.",
      });
    }
  });

export type ExpertSessionRecordV4 = z.infer<typeof ExpertSessionRecordV4Schema>;
