import { MissionContentReferenceSchema } from "./content-query.schema.ts";
import { z } from "zod";
import {
  CliRunStatusSchema,
  CliWatchObservedStatusSchema,
  CliWatchStopReasonSchema,
} from "./cli-v2.schema.ts";
import { HumanInteractionRequestEnvelopeSchema } from "./contracts.schema.ts";
import {
  IntegrationErrorSchema,
  IntegrationWarningSchema,
  IntegrationExitCodeSchema,
  IntegrationErrorExitCodes,
} from "./error.schema.ts";
import {
  MissionIdSchema,
  ExecutionIdSchema,
  RequestIdSchema,
  JsonValueSchema,
  OpaqueCursorSchema,
  EventIdSchema,
  IsoDateTimeSchema,
} from "./primitives.schema.ts";

/** Explicit --output-view compact; v2 remains the full default machine protocol. */
export const CliCompactResultSchema = z
  .object({
    schemaVersion: z.literal("pragma.cli-result/v3"),
    requestId: RequestIdSchema,
    command: z.string().min(1),
    status: CliRunStatusSchema,
    missionId: MissionIdSchema.optional(),
    executionId: ExecutionIdSchema.optional(),
    result: JsonValueSchema.optional(),
    resultContent: MissionContentReferenceSchema.optional(),
    interaction: HumanInteractionRequestEnvelopeSchema.optional(),
    error: IntegrationErrorSchema.optional(),
    warnings: z.array(IntegrationWarningSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.result !== undefined && value.resultContent !== undefined)
      context.addIssue({
        code: "custom",
        message: "Use exactly one inline result or content reference.",
      });
    if (
      ["accepted", "succeeded"].includes(value.status) !==
      (value.result !== undefined || value.resultContent !== undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Only accepted/succeeded commands carry a result.",
      });
    if ((value.status === "input_required") !== (value.interaction !== undefined))
      context.addIssue({
        code: "custom",
        message: "Input-required commands must carry the complete interaction.",
      });
    if ((value.status === "failed") !== (value.error !== undefined))
      context.addIssue({ code: "custom", message: "Failed commands must carry an error." });
  });

export const CliCompactEndSchema = z
  .object({
    status: CliRunStatusSchema,
    exitCode: IntegrationExitCodeSchema,
    missionId: MissionIdSchema.optional(),
    executionId: ExecutionIdSchema.optional(),
    lastCursor: OpaqueCursorSchema.optional(),
    observedStatus: CliWatchObservedStatusSchema.optional(),
    stopReason: CliWatchStopReasonSchema.optional(),
    error: IntegrationErrorSchema.optional(),
    warnings: z.array(IntegrationWarningSchema).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const expected =
      value.status === "failed"
        ? value.error === undefined
          ? undefined
          : IntegrationErrorExitCodes[value.error.code]
        : value.status === "input_required"
          ? 3
          : value.status === "interrupted"
            ? 130
            : 0;
    if (value.exitCode !== expected || (value.status === "failed") !== (value.error !== undefined))
      context.addIssue({ code: "custom", message: "End status, error and exit code must agree." });
    if ((value.observedStatus === undefined) !== (value.stopReason === undefined))
      context.addIssue({
        code: "custom",
        message: "Observed status and stop reason must be paired.",
      });
  });

export const CliCompactEventSchema = z
  .object({
    schemaVersion: z.literal("pragma.cli-event/v3"),
    requestId: RequestIdSchema,
    sequence: z.number().int().nonnegative(),
    type: z.string().min(1),
    data: JsonValueSchema,
    missionId: MissionIdSchema.optional(),
    executionId: ExecutionIdSchema.optional(),
    cursor: OpaqueCursorSchema.optional(),
    eventId: EventIdSchema.optional(),
    emittedAt: IsoDateTimeSchema.optional(),
    replayable: z.boolean().optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.replayable &&
      (value.cursor === undefined || value.eventId === undefined || value.emittedAt === undefined)
    )
      context.addIssue({
        code: "custom",
        message: "Replayable events require cursor, eventId and emittedAt.",
      });
    if (!value.replayable && value.cursor !== undefined)
      context.addIssue({ code: "custom", message: "Transient events cannot promise a cursor." });
    if (value.type === "stream.end") {
      const checked = CliCompactEndSchema.safeParse(value.data);
      if (!checked.success)
        context.addIssue({ code: "custom", message: "Invalid compact stream end." });
    }
  });
