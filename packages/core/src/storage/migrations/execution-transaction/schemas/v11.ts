import {
  AgentInstanceSchema,
  ExecutionEventSchema,
  InvocationSchema,
  RuntimeContextRecordSchema,
} from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV10Schema } from "../../execution/schemas/v10.ts";

export const ExecutionCommitJournalV11Schema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v11"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordV10Schema,
  invocations: InvocationSchema.array(),
  agents: AgentInstanceSchema.array(),
  contexts: RuntimeContextRecordSchema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

export type ExecutionCommitJournalV11 = z.infer<typeof ExecutionCommitJournalV11Schema>;
