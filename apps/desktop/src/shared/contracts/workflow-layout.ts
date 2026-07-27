import { PragmaExpertIdSchema } from "@pragma/interpreter/ast";
import { z } from "zod";

const WorkflowLayoutIdentitySchema = z.object({
  projectId: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9_-]+$/),
  flowId: PragmaExpertIdSchema,
});

export const WorkflowLayoutSchema = WorkflowLayoutIdentitySchema.extend({
  schemaVersion: z.literal("pragma.desktop-flow-layout/v2"),
  nodes: z.record(
    z.string().trim().min(1),
    z.object({ x: z.number().finite(), y: z.number().finite() }),
  ),
  viewport: z.object({
    x: z.number().finite(),
    y: z.number().finite(),
    zoom: z.number().finite().positive().max(4),
  }),
  updatedAt: z.string().datetime(),
});

export const GetWorkflowLayoutSchema = WorkflowLayoutIdentitySchema;
export const DeleteWorkflowLayoutSchema = WorkflowLayoutIdentitySchema;
