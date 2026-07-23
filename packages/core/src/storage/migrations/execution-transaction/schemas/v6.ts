import {
  AgentInstanceSchema,
  ExecutionEventSchema,
  InvocationSchema,
  RuntimeContextRecordSchema,
} from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV5Schema } from "../../execution/schemas/v5.ts";

export const ExecutionCommitJournalV6Schema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v6"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordV5Schema,
  invocations: InvocationSchema.array(),
  agents: AgentInstanceSchema.array(),
  contexts: RuntimeContextRecordSchema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

export type ExecutionCommitJournalV6 = z.infer<typeof ExecutionCommitJournalV6Schema>;
