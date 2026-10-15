import { z } from "zod";
import { RunOutcomeSchema } from "./cli-v2.schema.ts";
import { IntegrationErrorSchema } from "./error.schema.ts";
import {
  MissionIdSchema,
  ExecutionIdSchema,
  RequestIdSchema,
  JsonValueSchema,
} from "./primitives.schema.ts";

export const CliOwnerRequestSchema = z
  .object({
    schemaVersion: z.literal("pragma.cli-owner-request/v1"),
    requestId: RequestIdSchema,
    argv: z.array(z.string().max(4_194_304)).max(256),
    stdin: z.string().max(5_592_408).optional(),
  })
  .strict();
export const CliOwnerFrameSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("started"),
      missionId: MissionIdSchema,
      executionId: ExecutionIdSchema.optional(),
      operationId: z.string().min(1).max(512).optional(),
      operationState: z.string().min(1).max(64).optional(),
    })
    .strict(),
  z.object({ type: z.literal("event"), event: JsonValueSchema }).strict(),
  z.object({ type: z.literal("completed"), outcome: RunOutcomeSchema }).strict(),
  z.object({ type: z.literal("failed"), error: IntegrationErrorSchema }).strict(),
]);
export const CliOwnerCancelSchema = z
  .object({ type: z.literal("cancel"), requestId: RequestIdSchema })
  .strict();
export type CliOwnerRequest = z.infer<typeof CliOwnerRequestSchema>;
export type CliOwnerFrame = z.infer<typeof CliOwnerFrameSchema>;
