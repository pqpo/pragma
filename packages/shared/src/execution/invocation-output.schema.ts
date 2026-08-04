import { z } from "zod";

export const ContextOutputReferenceSchema = z.object({
  namespace: z.string().min(1),
  id: z.string().min(1),
  revision: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
});

export const InlineInvocationOutputSchema = z.object({
  type: z.literal("inline"),
  value: z.unknown(),
});

export const ContextInvocationOutputSchema = z.object({
  type: z.literal("context"),
  summary: z.string(),
  contexts: z.array(ContextOutputReferenceSchema).min(1),
});

export const InvocationOutputSchema = z.discriminatedUnion("type", [
  InlineInvocationOutputSchema,
  ContextInvocationOutputSchema,
]);

export type ContextOutputReference = z.infer<typeof ContextOutputReferenceSchema>;
export type InlineInvocationOutput = z.infer<typeof InlineInvocationOutputSchema>;
export type ContextInvocationOutput = z.infer<typeof ContextInvocationOutputSchema>;
export type InvocationOutput = z.infer<typeof InvocationOutputSchema>;
