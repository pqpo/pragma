import { z } from "zod";

export const ContextTriggerSchema = z.enum(["always_on", "model_decision", "manual"]);

export type ContextTrigger = z.infer<typeof ContextTriggerSchema>;
