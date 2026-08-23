import {
  AgentInstanceSchema,
  ExecutionEventSchema,
  RuntimeContextRecordSchema,
} from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV9Schema } from "../../execution/schemas/v9.ts";
import { InvocationV9Schema } from "../../execution/schemas/invocation-v9.ts";

export const ExecutionCommitJournalV10Schema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v10"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordV9Schema,
  invocations: InvocationV9Schema.array(),
  agents: AgentInstanceSchema.array(),
  contexts: RuntimeContextRecordSchema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

export type ExecutionCommitJournalV10 = z.infer<typeof ExecutionCommitJournalV10Schema>;
