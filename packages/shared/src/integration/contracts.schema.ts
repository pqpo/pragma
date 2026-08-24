import { z } from "zod";

import { ExecutionStatusSchema } from "../execution/execution.schema.ts";
import {
  HumanInteractionRequestSchema,
  HumanInteractionResponseSchema,
} from "../execution/human-interaction.schema.ts";
import {
  IntegrationErrorSchema,
  IntegrationExitCodeSchema,
  IntegrationWarningSchema,
} from "./error.schema.ts";
import {
  CommandIdSchema,
  EventIdSchema,
  ExecutionIdSchema,
  FencingTokenSchema,
  IntegrationProtocolVersionSchema,
  IntegrationRequestMetaSchema,
  InteractionIdSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MissionIdSchema,
  OpaqueCursorSchema,
  OperationIdSchema,
  RequestIdSchema,
  SemanticResourceIdSchema,
} from "./primitives.schema.ts";

export const ExecutorReferenceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("expert"), id: SemanticResourceIdSchema }).strict(),
  z.object({ kind: z.literal("team"), id: SemanticResourceIdSchema }).strict(),
  z.object({ kind: z.literal("flow"), id: SemanticResourceIdSchema }).strict(),
]);

export const WorkspaceRequirementSchema = z
  .object({ required: z.boolean(), allowNonGitDirectory: z.boolean() })
  .strict();

export const WorkspaceSelectionSchema = z
  .object({
    schemaVersion: z.literal("pragma.integration-workspace/v1"),
    requestedPath: z.string().min(1),
    canonicalPath: z.string().min(1),
    displayName: z.string().min(1),
    identityHash: z.string().regex(/^sha256:[0-9a-f]{64}$/),
    access: z
      .object({ exists: z.boolean(), readable: z.boolean(), writable: z.boolean() })
      .strict(),
    source: z.enum(["explicit", "cwd", "mission"]),
  })
  .strict();

/** Metadata-only reference. Secret values, ciphertext, and keychain locators are intentionally absent. */
export const SecretRefSchema = z
  .object({
    schemaVersion: z.literal("pragma.secret-ref/v1"),
    secretId: z.string().uuid(),
    owner: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("model-provider"), providerId: z.string().min(1) }).strict(),
      z
        .object({
          kind: z.literal("capability"),
          capabilityId: z.string().min(1),
          name: z.string().min(1),
        })
        .strict(),
      z.object({ kind: z.literal("plugin-binding"), bindingRef: z.string().min(1) }).strict(),
    ]),
    revision: z.string().uuid(),
  })
  .strict();

export type SecretRef = z.infer<typeof SecretRefSchema>;

export const ExecutorDescriptorSchema = z
  .object({
    schemaVersion: z.literal("pragma.integration-executor/v1"),
    ref: ExecutorReferenceSchema,
    name: z.string().min(1),
    description: z.string(),
    source: z.enum(["built_in", "project", "installed"]),
    project: z
      .object({
        projectId: SemanticResourceIdSchema,
        revision: z.number().int().positive(),
        fingerprint: z.string().min(1),
      })
      .strict()
      .optional(),
    availability: z
      .object({
        status: z.enum(["ready", "needs_attention", "unavailable"]),
        blockingCodes: z.array(z.string().min(1)),
      })
      .strict(),
    inputSchema: JsonValueSchema.optional(),
    workspace: WorkspaceRequirementSchema,
    capabilities: z
      .object({
        interactive: z.boolean(),
        resumable: z.boolean(),
        steerable: z.boolean(),
        supportsQueue: z.boolean(),
      })
      .strict(),
  })
  .strict();

export const MissionOperationStateSchema = z.enum([
  "accepted",
  "queued",
  "applying",
  "applied",
  "rejected",
  "expired",
  "failed",
  "cancelled",
]);
export const MissionOperationTransitions = {
  accepted: ["queued", "rejected", "expired", "failed", "cancelled"],
  queued: ["applying", "rejected", "expired", "failed", "cancelled"],
  applying: ["applied", "rejected", "expired", "failed"],
  applied: [],
  rejected: [],
  expired: [],
  failed: [],
  cancelled: [],
} as const satisfies Record<
  z.infer<typeof MissionOperationStateSchema>,
  readonly z.infer<typeof MissionOperationStateSchema>[]
>;

export function canTransitionMissionOperation(
  from: z.infer<typeof MissionOperationStateSchema>,
  to: z.infer<typeof MissionOperationStateSchema>,
): boolean {
  return (MissionOperationTransitions[from] as readonly string[]).includes(to);
}
export const MissionOperationKindSchema = z.enum([
  "run",
  "resume",
  "send",
  "steer",
  "respond",
  "interrupt",
  "queue.remove",
  "queue.resume",
  "queue.steer",
]);

const MissionOperationTargetSchema = z
  .object({
    executionId: ExecutionIdSchema.optional(),
    turnId: z.string().min(1).optional(),
    interactionId: InteractionIdSchema.optional(),
    queueItemId: z.string().uuid().optional(),
  })
  .strict();

const MissionOperationResultSchema = z
  .object({
    missionId: MissionIdSchema,
    executionId: ExecutionIdSchema.optional(),
    interactionId: InteractionIdSchema.optional(),
    queueItemId: z.string().uuid().optional(),
    queueItemRevision: z.number().int().nonnegative().optional(),
  })
  .strict();

export const MissionOperationSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-operation/v1"),
    operationId: OperationIdSchema,
    requestId: RequestIdSchema,
    missionId: MissionIdSchema,
    kind: MissionOperationKindSchema,
    state: MissionOperationStateSchema,
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    target: MissionOperationTargetSchema.optional(),
    result: MissionOperationResultSchema.optional(),
    error: IntegrationErrorSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.state === "applied" && value.result === undefined) {
      context.addIssue({
        code: "custom",
        path: ["result"],
        message: "Applied operations require a result.",
      });
    }
    if (["rejected", "expired", "failed"].includes(value.state) && value.error === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error"],
        message: "Failed operations require an error.",
      });
    }
    if (
      (value.kind === "steer" || value.kind === "queue.steer") &&
      (value.target?.executionId === undefined || value.target.turnId === undefined)
    ) {
      context.addIssue({
        code: "custom",
        path: ["target"],
        message: "Strict steer operations require executionId and turnId targets.",
      });
    }
  });

export const MissionCommandKindSchema = z.enum([
  "send",
  "steer",
  "respond",
  "interrupt",
  "queue.remove",
  "queue.resume",
  "queue.steer",
]);

const TextInputPayloadSchema = z.object({ prompt: z.string().min(1) }).strict();
const MissionCommandPayloadSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("send"), input: TextInputPayloadSchema }).strict(),
  z.object({ kind: z.literal("steer"), input: TextInputPayloadSchema }).strict(),
  z.object({ kind: z.literal("respond"), response: HumanInteractionResponseSchema }).strict(),
  z.object({ kind: z.literal("interrupt"), reason: z.string().min(1).optional() }).strict(),
  z.object({ kind: z.literal("queue.remove"), requestId: RequestIdSchema }).strict(),
  z.object({ kind: z.literal("queue.resume") }).strict(),
  z
    .object({
      kind: z.literal("queue.steer"),
      input: TextInputPayloadSchema,
      requestId: RequestIdSchema,
    })
    .strict(),
]);

export const MissionCommandSchema = z
  .object({
    schemaVersion: z.literal("pragma.mission-command/v1"),
    commandId: CommandIdSchema,
    request: IntegrationRequestMetaSchema,
    missionId: MissionIdSchema,
    kind: MissionCommandKindSchema,
    target: MissionOperationTargetSchema.optional(),
    payload: MissionCommandPayloadSchema,
    targetFencingToken: FencingTokenSchema.optional(),
    state: z.enum(["pending", "accepted", "applied", "rejected", "expired"]),
    createdAt: IsoDateTimeSchema,
    expiresAt: IsoDateTimeSchema.optional(),
    acknowledgedAt: IsoDateTimeSchema.optional(),
    appliedAt: IsoDateTimeSchema.optional(),
    error: IntegrationErrorSchema.optional(),
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

export const HumanInteractionRequestEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("pragma.human-interaction/v1"),
    kind: z.literal("request"),
    missionId: MissionIdSchema,
    executionId: ExecutionIdSchema,
    interactionId: InteractionIdSchema,
    sensitive: z.boolean().default(false),
    interaction: HumanInteractionRequestSchema,
  })
  .strict();

export const HumanInteractionResponseEnvelopeSchema = z
  .object({
    schemaVersion: z.literal("pragma.human-interaction/v1"),
    kind: z.literal("response"),
    missionId: MissionIdSchema,
    executionId: ExecutionIdSchema,
    interactionId: InteractionIdSchema,
    sensitive: z.boolean().default(false),
    interaction: HumanInteractionResponseSchema,
  })
  .strict();

export const HumanInteractionEnvelopeSchema = z.discriminatedUnion("kind", [
  HumanInteractionRequestEnvelopeSchema,
  HumanInteractionResponseEnvelopeSchema,
]);

export const BoardItemSummarySchema = z
  .object({
    id: z.string().min(1),
    namespace: z.literal("mission-board"),
    description: z.string().optional(),
    trigger: z.enum(["manual", "model_decision", "always_on"]),
    priority: z.enum(["critical", "high", "normal", "low"]),
    revision: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const BoardListResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.board-list/v1"),
    missionId: MissionIdSchema,
    items: z.array(BoardItemSummarySchema),
    nextCursor: OpaqueCursorSchema.optional(),
  })
  .strict();
export const BoardReadResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.board-read/v1"),
    missionId: MissionIdSchema,
    item: BoardItemSummarySchema.extend({
      content: z.string(),
      contentRange: z
        .object({
          start: z.number().int().nonnegative(),
          end: z.number().int().nonnegative(),
          totalBytes: z.number().int().nonnegative(),
          nextStart: z.number().int().nonnegative().optional(),
        })
        .strict(),
    }),
  })
  .strict();
export const BoardSearchResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.board-search/v1"),
    missionId: MissionIdSchema,
    query: z.string(),
    matches: z.array(
      z
        .object({
          item: BoardItemSummarySchema,
          line: z.number().int().positive().optional(),
          snippet: z.string(),
        })
        .strict(),
    ),
    nextCursor: OpaqueCursorSchema.optional(),
  })
  .strict();

export const CliResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.cli-result/v1"),
    requestId: RequestIdSchema,
    command: z.string().min(1),
    ok: z.boolean(),
    result: JsonValueSchema.optional(),
    error: IntegrationErrorSchema.optional(),
    warnings: z.array(IntegrationWarningSchema).default([]),
    meta: z
      .object({
        startedAt: IsoDateTimeSchema,
        completedAt: IsoDateTimeSchema,
        durationMs: z.number().int().nonnegative(),
        cliVersion: z.string().min(1),
        protocolVersion: IntegrationProtocolVersionSchema,
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.ok && (value.result === undefined || value.error !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Successful results require result and forbid error.",
      });
    }
    if (!value.ok && (value.error === undefined || value.result !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Failed results require error and forbid result.",
      });
    }
  });

const EventDataSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("mission.snapshot"),
      data: z.object({ missionId: MissionIdSchema, status: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("mission.created"),
      data: z.object({ missionId: MissionIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("mission.status.changed"),
      data: z.object({ previous: z.string().min(1), current: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("execution.started"),
      data: z.object({ executionId: ExecutionIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("execution.status.changed"),
      data: z.object({ executionId: ExecutionIdSchema, status: ExecutionStatusSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("output.delta"),
      data: z
        .object({
          itemId: z.string().min(1),
          channel: z.enum(["assistant", "thinking", "tool"]),
          delta: z.string(),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("message.committed"),
      data: z.object({ itemId: z.string().min(1), content: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("human.interaction.requested"),
      data: HumanInteractionRequestEnvelopeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("human.interaction.resolved"),
      data: HumanInteractionResponseEnvelopeSchema,
    })
    .strict(),
  z
    .object({
      type: z.literal("queue.item.changed"),
      data: z.object({ requestId: RequestIdSchema, state: z.string().min(1) }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command.accepted"),
      data: z.object({ commandId: CommandIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command.applied"),
      data: z.object({ commandId: CommandIdSchema }).strict(),
    })
    .strict(),
  z
    .object({
      type: z.literal("command.rejected"),
      data: z.object({ commandId: CommandIdSchema, error: IntegrationErrorSchema }).strict(),
    })
    .strict(),
  z.object({ type: z.literal("warning"), data: IntegrationWarningSchema }).strict(),
  z.object({ type: z.literal("heartbeat"), data: z.object({}).strict() }).strict(),
  z
    .object({
      type: z.literal("stream.end"),
      data: z
        .object({
          status: z.enum(["completed", "failed", "interrupted"]),
          exitCode: IntegrationExitCodeSchema,
          lastCursor: OpaqueCursorSchema.optional(),
          error: IntegrationErrorSchema.optional(),
        })
        .strict(),
    })
    .strict(),
]);

export const CliEventSchema = z
  .object({
    schemaVersion: z.literal("pragma.cli-event/v1"),
    requestId: RequestIdSchema,
    eventId: EventIdSchema,
    sequence: z.number().int().nonnegative(),
    emittedAt: IsoDateTimeSchema,
    missionId: MissionIdSchema.optional(),
    operationId: OperationIdSchema.optional(),
    replayable: z.boolean(),
    cursor: OpaqueCursorSchema.optional(),
  })
  .strict()
  .and(EventDataSchema)
  .superRefine((value, context) => {
    if (value.replayable && value.cursor === undefined) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "Replayable events require a cursor.",
      });
    }
    if (!value.replayable && value.cursor !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["cursor"],
        message: "Transient events cannot promise a cursor.",
      });
    }
  });

export const CliEventStreamSchema = z.array(CliEventSchema).superRefine((events, context) => {
  let sawEnd = false;
  let previousSequence = -1;

  for (const [index, event] of events.entries()) {
    if (event.sequence <= previousSequence) {
      context.addIssue({
        code: "custom",
        path: [index, "sequence"],
        message: "Event sequence must strictly increase within a stream.",
      });
    }
    previousSequence = event.sequence;
    if (event.type === "stream.end") {
      if (sawEnd || index !== events.length - 1) {
        context.addIssue({
          code: "custom",
          path: [index, "type"],
          message: "stream.end must occur exactly once and be the final event.",
        });
      }
      sawEnd = true;
    }
  }

  if (!sawEnd) {
    context.addIssue({
      code: "custom",
      message: "A complete event stream must end with exactly one stream.end event.",
    });
  }
});

export type WorkspaceSelection = z.infer<typeof WorkspaceSelectionSchema>;
export type ExecutorDescriptor = z.infer<typeof ExecutorDescriptorSchema>;
export type MissionOperation = z.infer<typeof MissionOperationSchema>;
export type MissionCommand = z.infer<typeof MissionCommandSchema>;
export type HumanInteractionEnvelope = z.infer<typeof HumanInteractionEnvelopeSchema>;
export type CliResult = z.infer<typeof CliResultSchema>;
export type CliEvent = z.infer<typeof CliEventSchema>;
