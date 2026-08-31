import { z } from "zod";

import { AgentMessageUsageSchema } from "../agent-message.schema.ts";
import { HumanInteractionRequestEnvelopeSchema } from "./contracts.schema.ts";
import { ExecutorReferenceSchema, WorkspaceSelectionSchema } from "./contracts.schema.ts";
import {
  IntegrationErrorExitCodes,
  IntegrationErrorSchema,
  IntegrationExitCodeSchema,
  IntegrationWarningSchema,
} from "./error.schema.ts";
import {
  EventIdSchema,
  ExecutionIdSchema,
  IsoDateTimeSchema,
  JsonValueSchema,
  MissionIdSchema,
  OpaqueCursorSchema,
  RequestIdSchema,
} from "./primitives.schema.ts";

/** The explicit run lifecycle used by the v2 CLI wire protocol. */
export const CliRunStatusSchema = z.enum([
  "accepted",
  "succeeded",
  "input_required",
  "failed",
  "interrupted",
]);

/** Final Mission state observed by a read-only `mission watch` command. */
export const CliWatchObservedStatusSchema = z.enum([
  "input_required",
  "succeeded",
  "failed",
  "interrupted",
  "detached",
]);

/** Reason a read-only `mission watch` command stopped observing the Mission. */
export const CliWatchStopReasonSchema = z.enum([
  "input_required",
  "succeeded",
  "failed",
  "interrupted",
  "detached",
]);

const RunOutcomeCommonSchema = z
  .object({
    missionId: MissionIdSchema.optional(),
    executionId: ExecutionIdSchema.optional(),
    executor: ExecutorReferenceSchema.optional(),
    workspace: WorkspaceSelectionSchema.optional(),
    usage: AgentMessageUsageSchema.optional(),
    warnings: z.array(IntegrationWarningSchema).default([]),
  })
  .strict();

const AcceptedOutcomeSchema = RunOutcomeCommonSchema.extend({
  status: z.literal("accepted"),
  result: JsonValueSchema,
  interaction: z.never().optional(),
  error: z.never().optional(),
});

const SucceededOutcomeSchema = RunOutcomeCommonSchema.extend({
  status: z.literal("succeeded"),
  result: JsonValueSchema,
  interaction: z.never().optional(),
  error: z.never().optional(),
});

const InputRequiredOutcomeSchema = RunOutcomeCommonSchema.extend({
  status: z.literal("input_required"),
  result: z.never().optional(),
  interaction: HumanInteractionRequestEnvelopeSchema,
  error: z.never().optional(),
});

const FailedOutcomeSchema = RunOutcomeCommonSchema.extend({
  status: z.literal("failed"),
  result: z.never().optional(),
  interaction: z.never().optional(),
  error: IntegrationErrorSchema,
});

const InterruptedOutcomeSchema = RunOutcomeCommonSchema.extend({
  status: z.literal("interrupted"),
  result: z.never().optional(),
  interaction: z.never().optional(),
  error: z.never().optional(),
});

/** Status/payload association shared by the JSON result and JSONL final event. */
export const RunOutcomeSchema = z.discriminatedUnion("status", [
  AcceptedOutcomeSchema,
  SucceededOutcomeSchema,
  InputRequiredOutcomeSchema,
  FailedOutcomeSchema,
  InterruptedOutcomeSchema,
]);

const CliResultV2MetaSchema = z
  .object({
    startedAt: IsoDateTimeSchema,
    completedAt: IsoDateTimeSchema,
    durationMs: z.number().int().nonnegative(),
    cliVersion: z.string().min(1),
    protocolVersion: z.literal("pragma.integration/v2"),
  })
  .strict();

const CliResultV2BaseSchema = z
  .object({
    schemaVersion: z.literal("pragma.cli-result/v2"),
    requestId: RequestIdSchema,
    command: z.string().min(1),
    meta: CliResultV2MetaSchema,
  })
  .strict();

/** Machine-readable v2 result. Run status and its payload are mutually checked. */
export const CliResultV2Schema = z.union([
  CliResultV2BaseSchema.merge(AcceptedOutcomeSchema),
  CliResultV2BaseSchema.merge(SucceededOutcomeSchema),
  CliResultV2BaseSchema.merge(InputRequiredOutcomeSchema),
  CliResultV2BaseSchema.merge(FailedOutcomeSchema),
  CliResultV2BaseSchema.merge(InterruptedOutcomeSchema),
]);

export const CliStreamEndDataV2Schema = z
  .object({
    status: CliRunStatusSchema,
    exitCode: IntegrationExitCodeSchema,
    missionId: MissionIdSchema.optional(),
    executionId: ExecutionIdSchema.optional(),
    executor: ExecutorReferenceSchema.optional(),
    workspace: WorkspaceSelectionSchema.optional(),
    result: JsonValueSchema.optional(),
    interaction: HumanInteractionRequestEnvelopeSchema.optional(),
    error: IntegrationErrorSchema.optional(),
    usage: AgentMessageUsageSchema.optional(),
    warnings: z.array(IntegrationWarningSchema).default([]),
    lastCursor: OpaqueCursorSchema.optional(),
    observedStatus: CliWatchObservedStatusSchema.optional(),
    stopReason: CliWatchStopReasonSchema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.observedStatus === undefined) !== (value.stopReason === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["stopReason"],
        message: "Watch observedStatus and stopReason must be provided together.",
      });
    }
    switch (value.status) {
      case "accepted":
      case "succeeded":
        if (value.exitCode !== 0) {
          context.addIssue({
            code: "custom",
            path: ["exitCode"],
            message: "Terminal success uses 0.",
          });
        }
        if (value.result === undefined) {
          context.addIssue({
            code: "custom",
            path: ["result"],
            message: "Successful runs require result.",
          });
        }
        if (value.interaction !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["interaction"],
            message: "Successful runs forbid interaction.",
          });
        }
        if (value.error !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["error"],
            message: "Successful runs forbid error.",
          });
        }
        return;
      case "input_required":
        if (value.exitCode !== 3) {
          context.addIssue({
            code: "custom",
            path: ["exitCode"],
            message: "Pending input uses 3.",
          });
        }
        if (value.interaction === undefined) {
          context.addIssue({
            code: "custom",
            path: ["interaction"],
            message: "Pending runs require an interaction envelope.",
          });
        }
        if (value.result !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["result"],
            message: "Pending runs forbid result.",
          });
        }
        if (value.error !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["error"],
            message: "Pending runs forbid error.",
          });
        }
        return;
      case "failed":
        if (value.error === undefined) {
          context.addIssue({
            code: "custom",
            path: ["error"],
            message: "Failed runs require an error.",
          });
        } else {
          if (value.error.code === "INTERRUPTED") {
            context.addIssue({
              code: "custom",
              path: ["error", "code"],
              message: "Interrupted errors must use the interrupted status.",
            });
          }
          if (value.exitCode !== IntegrationErrorExitCodes[value.error.code]) {
            context.addIssue({
              code: "custom",
              path: ["exitCode"],
              message: "Failed run exit code must match the error code.",
            });
          }
        }
        if (value.result !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["result"],
            message: "Failed runs forbid result.",
          });
        }
        if (value.interaction !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["interaction"],
            message: "Failed runs forbid interaction.",
          });
        }
        return;
      case "interrupted":
        if (value.exitCode !== 130) {
          context.addIssue({
            code: "custom",
            path: ["exitCode"],
            message: "Interrupted runs use 130.",
          });
        }
        if (value.result !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["result"],
            message: "Interrupted runs forbid result.",
          });
        }
        if (value.interaction !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["interaction"],
            message: "Interrupted runs forbid interaction.",
          });
        }
        if (value.error !== undefined) {
          context.addIssue({
            code: "custom",
            path: ["error"],
            message: "Interrupted runs forbid error.",
          });
        }
        return;
    }
  });

/** One independently parseable v2 JSONL event. Event data remains open for runtime-specific events. */
export const CliEventV2Schema = z
  .object({
    schemaVersion: z.literal("pragma.cli-event/v2"),
    requestId: RequestIdSchema,
    eventId: EventIdSchema,
    sequence: z.number().int().nonnegative(),
    emittedAt: IsoDateTimeSchema,
    missionId: MissionIdSchema.optional(),
    executionId: ExecutionIdSchema.optional(),
    replayable: z.boolean(),
    cursor: OpaqueCursorSchema.optional(),
    type: z.string().min(1),
    data: JsonValueSchema,
  })
  .strict()
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
    if (value.type === "stream.end") {
      const parsed = CliStreamEndDataV2Schema.safeParse(value.data);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: ["data"],
          message: "Invalid v2 stream.end data.",
        });
      }
    }
  });

export const CliEventV2StreamSchema = z.array(CliEventV2Schema).superRefine((events, context) => {
  let endCount = 0;
  const requestId = events[0]?.requestId;
  let previousSequence = -1;
  for (const [index, event] of events.entries()) {
    if (requestId !== undefined && event.requestId !== requestId) {
      context.addIssue({
        code: "custom",
        path: [index, "requestId"],
        message: "Stream requestId changed.",
      });
    }
    if (event.sequence <= previousSequence) {
      context.addIssue({
        code: "custom",
        path: [index, "sequence"],
        message: "Event sequence must increase.",
      });
    }
    previousSequence = event.sequence;
    if (event.type === "stream.end") {
      endCount += 1;
      if (index !== events.length - 1) {
        context.addIssue({
          code: "custom",
          path: [index, "type"],
          message: "stream.end must be final.",
        });
      }
    }
  }
  if (endCount !== 1) {
    context.addIssue({ code: "custom", message: "A complete stream has exactly one stream.end." });
  }
});

export type CliRunStatus = z.infer<typeof CliRunStatusSchema>;
export type CliWatchObservedStatus = z.infer<typeof CliWatchObservedStatusSchema>;
export type CliWatchStopReason = z.infer<typeof CliWatchStopReasonSchema>;
export type RunOutcome = z.infer<typeof RunOutcomeSchema>;
export type CliResultV2 = z.infer<typeof CliResultV2Schema>;
export type CliStreamEndDataV2 = z.infer<typeof CliStreamEndDataV2Schema>;
export type CliEventV2 = z.infer<typeof CliEventV2Schema>;
