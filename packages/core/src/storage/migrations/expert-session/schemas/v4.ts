import { ExecutionStatusSchema, RuntimeContextRecordSchema } from "@pragma/shared";
import { z } from "zod";

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
    contexts: z.record(z.string(), RuntimeContextRecordSchema),
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
