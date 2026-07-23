import { z } from "zod";

export const HandoffContextReferenceSchema = z.object({
  namespace: z.literal("pragma.handoff"),
  id: z.string().min(1),
  revision: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mediaType: z.string().min(1),
});

export const InlineInvocationHandoffSchema = z.object({
  type: z.literal("inline"),
  value: z.unknown(),
});

export const ContextInvocationHandoffSchema = z.object({
  type: z.literal("context"),
  summary: z.string(),
  contexts: z.array(HandoffContextReferenceSchema).min(1),
});

export const InvocationHandoffSchema = z.discriminatedUnion("type", [
  InlineInvocationHandoffSchema,
  ContextInvocationHandoffSchema,
]);

export type HandoffContextReference = z.infer<typeof HandoffContextReferenceSchema>;
export type InlineInvocationHandoff = z.infer<typeof InlineInvocationHandoffSchema>;
export type ContextInvocationHandoff = z.infer<typeof ContextInvocationHandoffSchema>;
export type InvocationHandoff = z.infer<typeof InvocationHandoffSchema>;
