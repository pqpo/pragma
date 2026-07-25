import {
  AgentInstanceSchema,
  ExecutionEventSchema,
  InvocationSchema,
  RuntimeContextRecordSchema,
} from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV7Schema } from "../../execution/schemas/v7.ts";

export const ExecutionCommitJournalV8Schema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v8"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordV7Schema,
  invocations: InvocationSchema.array(),
  agents: AgentInstanceSchema.array(),
  contexts: RuntimeContextRecordSchema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

export type ExecutionCommitJournalV8 = z.infer<typeof ExecutionCommitJournalV8Schema>;
