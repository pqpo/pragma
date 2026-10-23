import { z } from "zod";
import { AgentImageContentSchema, AgentTextContentSchema } from "./agent-message.schema.ts";

const metadata = {
  annotations: z
    .object({
      audience: z.array(z.enum(["user", "assistant"])).optional(),
      priority: z.number().min(0).max(1).optional(),
      lastModified: z.string().optional(),
    })
    .optional(),
  _meta: z.record(z.string(), z.unknown()).optional(),
};

/** Execution-time tool content; persisted Agent messages retain their own versioned contract. */
export const ToolContentSchema = z.discriminatedUnion("type", [
  z.looseObject({ ...AgentTextContentSchema.shape, ...metadata }),
  z.looseObject({ ...AgentImageContentSchema.shape, ...metadata }),
  z.looseObject({ type: z.literal("audio"), data: z.string(), mimeType: z.string(), ...metadata }),
  z.looseObject({
    type: z.literal("resource_link"),
    uri: z.string(),
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
    ...metadata,
  }),
  z.looseObject({
    type: z.literal("resource"),
    resource: z.union([
      z.looseObject({
        uri: z.string(),
        mimeType: z.string().optional(),
        text: z.string(),
        _meta: metadata._meta,
      }),
      z.looseObject({
        uri: z.string(),
        mimeType: z.string().optional(),
        blob: z.string(),
        _meta: metadata._meta,
      }),
    ]),
    ...metadata,
  }),
]);

export type ToolContent = z.infer<typeof ToolContentSchema>;
