import {
  AgentInstanceSchema,
  ExecutionEventSchema,
  InvocationSchema,
  RuntimeContextRecordSchema,
} from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV8Schema } from "../../execution/schemas/v8.ts";

export const ExecutionCommitJournalV9Schema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v9"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordV8Schema,
  invocations: InvocationSchema.array(),
  agents: AgentInstanceSchema.array(),
  contexts: RuntimeContextRecordSchema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

export type ExecutionCommitJournalV9 = z.infer<typeof ExecutionCommitJournalV9Schema>;
