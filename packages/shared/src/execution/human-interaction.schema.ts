import { z } from "zod";

export const HumanInteractionKindSchema = z.enum([
  "question",
  "approval",
  "review_gate",
  "manual_intervention",
]);

export const HumanInteractionQuestionSchema = z.object({
  header: z.string().min(1),
  question: z.string().min(1),
  kind: z.enum(["single_choice", "multiple_choice", "text"]),
  options: z
    .array(z.object({ label: z.string().min(1), description: z.string().default("") }))
    .default([]),
});

export const HumanInteractionRequestSchema = z.object({
  kind: HumanInteractionKindSchema,
  title: z.string().min(1).optional(),
  prompt: z.string().min(1).optional(),
  questions: z.array(HumanInteractionQuestionSchema).optional(),
  options: z
    .array(z.object({ label: z.string().min(1), description: z.string().default("") }))
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

export const HumanInteractionRecordSchema = z.object({
  interactionId: z.string().min(1),
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  status: z.enum(["pending", "responded"]),
  request: HumanInteractionRequestSchema,
  response: HumanInteractionResponseSchema.optional(),
  requestId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export type HumanInteractionKind = z.infer<typeof HumanInteractionKindSchema>;
export type HumanInteractionQuestion = z.infer<typeof HumanInteractionQuestionSchema>;
export type HumanInteractionRequest = z.infer<typeof HumanInteractionRequestSchema>;
export type HumanInteractionResponse = z.infer<typeof HumanInteractionResponseSchema>;
export type HumanInteractionRecord = z.infer<typeof HumanInteractionRecordSchema>;
