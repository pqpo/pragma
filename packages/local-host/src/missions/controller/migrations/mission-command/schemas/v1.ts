import { z } from "zod";

const uuid = z.string().uuid();
const isoDateTime = z.string().datetime({ offset: true });
const jsonValue: z.ZodType<unknown> = z.lazy(() =>
  z.union([
    z.null(),
    z.boolean(),
    z.number().finite(),
    z.string(),
    z.array(jsonValue),
    z.record(z.string(), jsonValue),
  ]),
);
const request = z
  .object({
    schemaVersion: z.literal("pragma.integration-request/v1"),
    requestId: uuid,
    payloadHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    requestedAt: isoDateTime,
    client: z
      .object({
        surface: z.enum(["cli", "desktop"]),
        version: z.string().min(1),
        instanceId: uuid,
      })
      .strict(),
  })
  .strict();
const target = z
  .object({
    executionId: uuid.optional(),
    turnId: z.string().min(1).optional(),
    interactionId: z.string().min(1).max(512).optional(),
    queueItemId: uuid.optional(),
  })
  .strict();
const response = z.object({
  decision: z.string().min(1).optional(),
  selection: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  answers: z.unknown().optional(),
  approved: z.boolean().optional(),
  notes: z.string().optional(),
  data: z.unknown().optional(),
});
const input = z.object({ prompt: z.string().min(1) }).strict();
const payload = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), input }).strict(),
  z.object({ kind: z.literal("steer"), input }).strict(),
  z.object({ kind: z.literal("respond"), response }).strict(),
  z.object({ kind: z.literal("interrupt"), reason: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("queue.remove"), requestId: uuid }).strict(),
  z.object({ kind: z.literal("queue.resume") }).strict(),
  z.object({ kind: z.literal("queue.steer"), input: input.optional(), requestId: uuid }).strict(),
]);
const error = z
  .object({
    schemaVersion: z.literal("pragma.integration-error/v1"),
    code: z.string().min(1),
    message: z.string().min(1),
    retryable: z.boolean(),
    category: z.enum([
      "usage",
      "not_found",
      "conflict",
      "dependency",
      "permission",
      "protocol",
      "execution",
      "interrupted",
    ]),
    details: z.record(z.string(), jsonValue).optional(),
    causeId: uuid.optional(),
  })
  .strict();

/** Exact persisted Mission command envelope written by the v1 Inbox writer. */
export const MissionCommandV1Schema = z
  .object({
    schemaVersion: z.literal("pragma.mission-command/v1"),
    commandId: uuid,
    request,
    missionId: uuid,
    kind: z.enum([
      "send",
      "steer",
      "respond",
      "interrupt",
      "queue.remove",
      "queue.resume",
      "queue.steer",
    ]),
    target: target.optional(),
    payload,
    targetFencingToken: z
      .string()
      .regex(/^[1-9][0-9]*$/)
      .optional(),
    state: z.enum(["pending", "accepted", "applied", "rejected", "expired"]),
    createdAt: isoDateTime,
    expiresAt: isoDateTime.optional(),
    acknowledgedAt: isoDateTime.optional(),
    appliedAt: isoDateTime.optional(),
    error: error.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.kind !== value.payload.kind) {
      context.addIssue({
        code: "custom",
        path: ["payload", "kind"],
        message: "Command kind must match payload kind.",
      });
    }
    if (
      (value.kind === "steer" || value.kind === "queue.steer") &&
      (value.target?.executionId === undefined || value.target.turnId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Strict steer commands require executionId and turnId targets.",
      });
    }
    if (
      (value.kind === "steer" || value.kind === "queue.steer") &&
      value.targetFencingToken === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["targetFencingToken"],
        message: "Persisted strict steer commands require an owner fencing target.",
      });
    }
  });

export type MissionCommandV1 = z.infer<typeof MissionCommandV1Schema>;
