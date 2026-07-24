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
    .array(
      z.object({
        value: z.string().min(1).optional(),
        label: z.string().min(1),
        description: z.string().default(""),
      }),
    )
    .default([]),
});

export const HumanInteractionRequestSchema = z
  .object({
    kind: HumanInteractionKindSchema,
    title: z.string().min(1).optional(),
    prompt: z.string().min(1).optional(),
    questions: z.array(HumanInteractionQuestionSchema).optional(),
    options: z
      .array(
        z.object({
          value: z.string().min(1).optional(),
          label: z.string().min(1),
          description: z.string().default(""),
        }),
      )
      .optional(),
    approveOption: z.string().min(1).optional(),
    data: z.unknown().optional(),
  })
  .superRefine((value, context) => {
    if (value.approveOption === undefined) return;
    if (value.kind !== "approval") {
      context.addIssue({
        code: "custom",
        path: ["approveOption"],
        message: "approveOption is only valid for approval requests.",
      });
      return;
    }
    const labels = [
      ...(value.options ?? []).map((option) => option.label),
      ...(value.questions ?? []).flatMap((question) =>
        question.options.map((option) => option.label),
      ),
    ];
    if (labels.length > 0 && !labels.includes(value.approveOption)) {
      context.addIssue({
        code: "custom",
        path: ["approveOption"],
        message: "approveOption must match an approval choice.",
      });
    }
  });

export const HumanInteractionResponseSchema = z.object({
  decision: z.string().min(1).optional(),
  selection: z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]).optional(),
  answers: z.unknown().optional(),
  approved: z.boolean().optional(),
  notes: z.string().optional(),
  data: z.unknown().optional(),
});

const HumanInteractionRecordBaseSchema = z.object({
  interactionId: z.string().min(1),
  executionId: z.string().min(1),
  invocationId: z.string().min(1),
  request: HumanInteractionRequestSchema,
  requestId: z.string().min(1).optional(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
});

export const HumanInteractionRecordSchema = z.discriminatedUnion("status", [
  HumanInteractionRecordBaseSchema.extend({
    status: z.literal("pending"),
    response: z.never().optional(),
  }),
  HumanInteractionRecordBaseSchema.extend({
    status: z.literal("responded"),
    response: HumanInteractionResponseSchema,
  }),
]);

export type HumanInteractionKind = z.infer<typeof HumanInteractionKindSchema>;
export type HumanInteractionQuestion = z.infer<typeof HumanInteractionQuestionSchema>;
export type HumanInteractionRequest = z.infer<typeof HumanInteractionRequestSchema>;
export type HumanInteractionResponse = z.infer<typeof HumanInteractionResponseSchema>;
export type HumanInteractionRecord = z.infer<typeof HumanInteractionRecordSchema>;
