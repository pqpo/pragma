import {
  AgentInstanceSchema,
  ExecutionEventSchema,
  InvocationSchema,
  RuntimeContextRecordSchema,
} from "@pragma/shared";
import { z } from "zod";

import { ExecutionRecordV6Schema } from "../../execution/schemas/v6.ts";

export const ExecutionCommitJournalV7Schema = z.object({
  schemaVersion: z.literal("pragma.execution-transaction/v7"),
  commitId: z.string().min(1),
  signature: z.string().length(64),
  execution: ExecutionRecordV6Schema,
  invocations: InvocationSchema.array(),
  agents: AgentInstanceSchema.array(),
  contexts: RuntimeContextRecordSchema.array(),
  events: ExecutionEventSchema.array(),
  eventIds: z.array(z.string().min(1)),
});

export type ExecutionCommitJournalV7 = z.infer<typeof ExecutionCommitJournalV7Schema>;
