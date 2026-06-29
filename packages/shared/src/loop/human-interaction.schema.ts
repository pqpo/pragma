import { z } from "zod";

export const HumanInteractionKindSchema = z.enum([
  "question",
  "approval",
  "review_gate",
  "manual_intervention",
]);

export const HumanInteractionStatusSchema = z.enum(["pending", "responded"]);

export const HumanInteractionQuestionSchema = z.object({
  header: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(["single_choice", "multiple_choice", "text"]),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().default(""),
      }),
    )
    .default([]),
});

export const HumanInteractionRequestSchema = z.object({
  kind: HumanInteractionKindSchema,
  title: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  questions: z.array(HumanInteractionQuestionSchema).optional(),
  options: z
    .array(
      z.object({
        label: z.string().min(1),
        description: z.string().default(""),
      }),
    )
    .optional(),
  data: z.unknown().optional(),
});

export const HumanInteractionResponseSchema = z.object({
  decision: z.string().min(1).optional(),
  answers: z.unknown().optional(),
  approved: z.boolean().optional(),
  notes: z.string().optional(),
  data: z.unknown().optional(),
});

export const HumanInteractionOperatorSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["user", "system", "external"]).default("user"),
  displayName: z.string().min(1).optional(),
});

export const HumanInteractionRecordSchema = z.object({
  id: z.string().min(1),
  workflowRunId: z.string().min(1),
  taskRunId: z.string().min(1).optional(),
  stepId: z.string().min(1).optional(),
  kind: HumanInteractionKindSchema,
  status: HumanInteractionStatusSchema,
  request: HumanInteractionRequestSchema,
  response: HumanInteractionResponseSchema.optional(),
  operator: HumanInteractionOperatorSchema.optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  resolvedAt: z.string().datetime().optional(),
});

export type HumanInteractionKind = z.infer<typeof HumanInteractionKindSchema>;
export type HumanInteractionStatus = z.infer<typeof HumanInteractionStatusSchema>;
export type HumanInteractionQuestion = z.infer<typeof HumanInteractionQuestionSchema>;
export type HumanInteractionRequest = z.infer<typeof HumanInteractionRequestSchema>;
export type HumanInteractionResponse = z.infer<typeof HumanInteractionResponseSchema>;
export type HumanInteractionOperator = z.infer<typeof HumanInteractionOperatorSchema>;
export type HumanInteractionRecord = z.infer<typeof HumanInteractionRecordSchema>;
