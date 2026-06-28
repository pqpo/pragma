import { z } from "zod";

export const AgentTextContentSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
  textSignature: z.string().optional(),
});

export const AgentThinkingContentSchema = z.object({
  type: z.literal("thinking"),
  thinking: z.string(),
  thinkingSignature: z.string().optional(),
  redacted: z.boolean().optional(),
});

export const AgentImageContentSchema = z.object({
  type: z.literal("image"),
  data: z.string(),
  mimeType: z.string().min(1),
});

export const AgentToolCallContentSchema = z.object({
  type: z.literal("toolCall"),
  id: z.string().min(1),
  name: z.string().min(1),
  arguments: z.record(z.string(), z.unknown()),
  thoughtSignature: z.string().optional(),
});

export const AgentMessageUsageSchema = z.object({
  input: z.number().nonnegative(),
  output: z.number().nonnegative(),
  cacheRead: z.number().nonnegative(),
  cacheWrite: z.number().nonnegative(),
  cacheWrite1h: z.number().nonnegative().optional(),
  totalTokens: z.number().nonnegative(),
  cost: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
    total: z.number().nonnegative(),
  }),
});

export const AgentUserMessageSchema = z.object({
  role: z.literal("user"),
  content: z.union([
    z.string(),
    z.array(z.union([AgentTextContentSchema, AgentImageContentSchema])),
  ]),
  timestamp: z.number(),
});

export const AgentAssistantMessageSchema = z.object({
  role: z.literal("assistant"),
  content: z.array(
    z.union([AgentTextContentSchema, AgentThinkingContentSchema, AgentToolCallContentSchema]),
  ),
  api: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  responseModel: z.string().optional(),
  responseId: z.string().optional(),
  diagnostics: z.array(z.unknown()).optional(),
  usage: AgentMessageUsageSchema,
  stopReason: z.enum(["stop", "length", "toolUse", "error", "aborted"]),
  errorMessage: z.string().optional(),
  timestamp: z.number(),
});

export const AgentToolResultMessageSchema = z.object({
  role: z.literal("toolResult"),
  toolCallId: z.string().min(1),
  toolName: z.string().min(1),
  content: z.array(z.union([AgentTextContentSchema, AgentImageContentSchema])),
  details: z.unknown().optional(),
  isError: z.boolean(),
  timestamp: z.number(),
});

export const AgentBashExecutionMessageSchema = z.object({
  role: z.literal("bashExecution"),
  command: z.string(),
  output: z.string(),
  exitCode: z.number().int().optional(),
  cancelled: z.boolean(),
  truncated: z.boolean(),
  fullOutputPath: z.string().optional(),
  timestamp: z.number(),
  excludeFromContext: z.boolean().optional(),
});

export const AgentCustomMessageSchema = z.object({
  role: z.literal("custom"),
  customType: z.string().min(1),
  content: z.union([
    z.string(),
    z.array(z.union([AgentTextContentSchema, AgentImageContentSchema])),
  ]),
  display: z.boolean(),
  details: z.unknown().optional(),
  timestamp: z.number(),
});

export const AgentBranchSummaryMessageSchema = z.object({
  role: z.literal("branchSummary"),
  summary: z.string(),
  fromId: z.string().min(1),
  timestamp: z.number(),
});

export const AgentCompactionSummaryMessageSchema = z.object({
  role: z.literal("compactionSummary"),
  summary: z.string(),
  tokensBefore: z.number().nonnegative(),
  timestamp: z.number(),
});

export const AgentMessageSchema = z.discriminatedUnion("role", [
  AgentUserMessageSchema,
  AgentAssistantMessageSchema,
  AgentToolResultMessageSchema,
  AgentBashExecutionMessageSchema,
  AgentCustomMessageSchema,
  AgentBranchSummaryMessageSchema,
  AgentCompactionSummaryMessageSchema,
]);

export type AgentTextContent = z.infer<typeof AgentTextContentSchema>;
export type AgentThinkingContent = z.infer<typeof AgentThinkingContentSchema>;
export type AgentImageContent = z.infer<typeof AgentImageContentSchema>;
export type AgentToolCallContent = z.infer<typeof AgentToolCallContentSchema>;
export type AgentMessageUsage = z.infer<typeof AgentMessageUsageSchema>;
export type AgentUserMessage = z.infer<typeof AgentUserMessageSchema>;
export type AgentAssistantMessage = z.infer<typeof AgentAssistantMessageSchema>;
export type AgentToolResultMessage = z.infer<typeof AgentToolResultMessageSchema>;
export type AgentBashExecutionMessage = z.infer<typeof AgentBashExecutionMessageSchema>;
export type AgentCustomMessage = z.infer<typeof AgentCustomMessageSchema>;
export type AgentBranchSummaryMessage = z.infer<typeof AgentBranchSummaryMessageSchema>;
export type AgentCompactionSummaryMessage = z.infer<typeof AgentCompactionSummaryMessageSchema>;
export type AgentMessage = z.infer<typeof AgentMessageSchema>;
