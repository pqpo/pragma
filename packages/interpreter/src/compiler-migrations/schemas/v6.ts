import { PragmaFlowRunDryEvaluationResourceSchema } from "@pragma/evaluation/ast";
import { z } from "zod";

import {
  PragmaAutomationResourceSchema,
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
  PragmaRuntimeProfileResourceSchema,
} from "../../ast/pragma-dsl.schema.ts";

export const PragmaCompilerV6ResourceSchema = z.discriminatedUnion("kind", [
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
  PragmaAutomationResourceSchema,
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaRuntimeProfileResourceSchema,
  PragmaFlowRunDryEvaluationResourceSchema,
]);

export const PragmaCompilerV6BundleSchema = z
  .object({
    apiVersion: z.literal("pragma/v4"),
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaCompilerV6ResourceSchema).default([]),
  })
  .strict();

export type PragmaCompilerV6Resource = z.infer<typeof PragmaCompilerV6ResourceSchema>;
