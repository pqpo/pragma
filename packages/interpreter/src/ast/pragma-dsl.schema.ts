import { z } from "zod";

export const PragmaApiVersionSchema = z.literal("pragma/v1");

export const PragmaResourceKindSchema = z.enum(["expert", "team", "flow"]);

export const PragmaResourceRefSchema = z
  .string()
  .trim()
  .regex(
    /^(expert|team|flow|action|capability|context):[A-Za-z0-9][A-Za-z0-9._-]*(?:@[A-Za-z0-9][A-Za-z0-9.+_-]*)?$/,
    "Expected a Pragma resource reference such as expert:researcher@1.0.0.",
  );

export const PragmaExtensionRefSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*@[A-Za-z0-9][A-Za-z0-9.+_-]*$/);

export const PragmaMetadataSchema = z.object({
  id: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/),
  version: z.string().trim().min(1).max(100),
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().min(1).max(4_000),
  tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
});

export const PragmaToolBindingSchema = z
  .object({
    adapter: PragmaExtensionRefSchema,
    target: z.object({ ref: PragmaResourceRefSchema }).optional(),
    targets: z
      .array(z.object({ ref: PragmaResourceRefSchema }))
      .min(1)
      .optional(),
    tool: z
      .object({
        name: z.string().trim().min(1).max(128),
        description: z.string().trim().min(1).max(4_000),
        approval: z.enum(["none", "ask", "required"]).default("none"),
        timeoutMs: z.number().int().positive().optional(),
      })
      .optional(),
    policy: z
      .object({
        maxConcurrency: z.number().int().positive().default(4),
        maxDepth: z.number().int().positive().default(3),
        context: PragmaResourceRefSchema.default("context:pragma.context.fresh@v1"),
        runtimes: z.record(z.string().min(1), z.string().min(1)).default({}),
      })
      .optional(),
  })
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.targets === undefined)) {
      context.addIssue({
        code: "custom",
        message: "A tool binding must declare exactly one of target or targets.",
      });
    }
  });

export const PragmaExpertResourceSchema = z.object({
  apiVersion: PragmaApiVersionSchema,
  kind: z.literal("Expert"),
  metadata: PragmaMetadataSchema,
  spec: z.object({
    scope: z.string().max(10_000).default("general"),
    instructions: z.string().max(200_000).optional(),
    runtime: z
      .object({
        id: z.string().trim().min(1),
        model: z.string().trim().min(1).optional(),
        provider: z.string().trim().min(1).optional(),
      })
      .optional(),
    capabilities: z
      .array(
        z.object({
          ref: PragmaResourceRefSchema,
          kind: z.enum(["skill", "tools"]).optional(),
          tools: z.array(z.string().trim().min(1).max(128)).optional(),
        }),
      )
      .default([]),
    toolApprovals: z.record(z.string().max(200), z.enum(["none", "ask", "required"])).default({}),
    contextStores: z
      .array(
        z.object({
          ref: z.string().trim().min(1),
          enabled: z.boolean().default(true),
          priority: z.number().int().nonnegative().default(0),
        }),
      )
      .default([]),
    plugins: z
      .array(
        z.object({
          source: z.string().trim().min(1),
          config: z.unknown().optional(),
        }),
      )
      .default([]),
    tools: z.array(PragmaToolBindingSchema).default([]),
  }),
});

export const PragmaExpertTeamResourceSchema = z.object({
  apiVersion: PragmaApiVersionSchema,
  kind: z.literal("ExpertTeam"),
  metadata: PragmaMetadataSchema,
  spec: z.object({
    coordinator: z.object({ ref: PragmaResourceRefSchema }),
    members: z.array(z.object({ ref: PragmaResourceRefSchema })).min(1),
    delegation: z.object({
      allow: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
      maxConcurrency: z.number().int().positive().default(4),
      maxDepth: z.number().int().positive().default(3),
      context: PragmaResourceRefSchema.default("context:pragma.context.fresh@v1"),
      runtimes: z.record(z.string().min(1), z.string().min(1)).default({}),
    }),
  }),
});

export const PragmaFlowTargetSchema = z.union([
  z.string().trim().min(1),
  z.object({ goto: z.string().trim().min(1) }),
  z.object({ end: z.literal(true) }),
  z.object({ fail: z.string().trim().min(1) }),
]);

export const PragmaFlowRepeatTargetSchema = z.object({
  repeat: z.object({
    loop: z.string().trim().min(1),
    goto: z.string().trim().min(1),
  }),
});

export const PragmaFlowDestinationSchema = z.union([
  PragmaFlowTargetSchema,
  PragmaFlowRepeatTargetSchema,
]);

export const PragmaHumanRequestSchema = z.object({
  kind: z.enum(["approval", "question", "review_gate", "manual_intervention"]),
  title: z.string().min(1).optional(),
  prompt: z.string().optional(),
  questions: z
    .array(
      z.object({
        id: z.string().trim().min(1),
        type: z.enum(["single_choice", "multiple_choice", "text"]),
        label: z.string().min(1),
        options: z.array(z.string()).default([]),
      }),
    )
    .optional(),
});

export const PragmaFlowStepSchema = z
  .object({
    action: z.object({ ref: PragmaResourceRefSchema }).optional(),
    expert: z.object({ ref: PragmaResourceRefSchema }).optional(),
    team: z.object({ ref: PragmaResourceRefSchema }).optional(),
    flow: z.object({ ref: PragmaResourceRefSchema }).optional(),
    human: PragmaHumanRequestSchema.optional(),
    version: z.string().trim().min(1).default("1.0.0"),
    input: z.unknown().optional(),
    save: z
      .string()
      .trim()
      .regex(/^state\.[A-Za-z0-9_.-]+$/)
      .optional(),
    context: PragmaResourceRefSchema.optional(),
    runtime: z.string().trim().min(1).optional(),
    runtimes: z.record(z.string().min(1), z.string().min(1)).optional(),
  })
  .superRefine((value, context) => {
    const definitions = [value.action, value.expert, value.team, value.flow, value.human].filter(
      (entry) => entry !== undefined,
    );
    if (definitions.length !== 1) {
      context.addIssue({
        code: "custom",
        message: "A Flow step must declare exactly one of action, expert, team, flow, or human.",
      });
    }
  });

export const PragmaFlowTransitionSchema = z.union([
  PragmaFlowDestinationSchema,
  z.object({
    route: z.string().trim().min(1),
    cases: z.record(z.string(), PragmaFlowDestinationSchema),
    fallback: PragmaFlowDestinationSchema.optional(),
  }),
]);

export const PragmaFlowLoopSchema = z.object({
  entry: z.string().trim().min(1),
  maxIterations: z.number().int().positive(),
  onLimit: PragmaFlowTargetSchema.optional(),
});

export const PragmaFlowGraphSchema = z.object({
  start: z.string().trim().min(1),
  steps: z.record(z.string().trim().min(1), PragmaFlowStepSchema),
  loops: z.record(z.string().trim().min(1), PragmaFlowLoopSchema).default({}),
  transitions: z.record(z.string().trim().min(1), PragmaFlowTransitionSchema),
});

export const PragmaFlowResourceSchema = z.object({
  apiVersion: PragmaApiVersionSchema,
  kind: z.literal("Flow"),
  metadata: PragmaMetadataSchema,
  spec: z.object({
    input: z.object({ schema: z.unknown().optional() }).optional(),
    output: z
      .object({
        schema: z.unknown().optional(),
        value: z.unknown().optional(),
      })
      .optional(),
    limits: z
      .object({
        maxNodeVisits: z.number().int().positive().default(1_000),
        timeoutMs: z.number().int().positive().optional(),
      })
      .default({ maxNodeVisits: 1_000 }),
    graph: PragmaFlowGraphSchema,
  }),
});

export const PragmaResourceSchema = z.discriminatedUnion("kind", [
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
]);

export const PragmaBundleSchema = z.object({
  apiVersion: PragmaApiVersionSchema,
  kind: z.literal("Bundle"),
  imports: z.array(z.string().trim().min(1)).default([]),
  resources: z.array(PragmaResourceSchema).default([]),
});

export const PragmaLockSchema = z.object({
  apiVersion: PragmaApiVersionSchema,
  kind: z.literal("Lock"),
  compilerVersion: z.string().min(1),
  resources: z.array(
    z.object({
      ref: PragmaResourceRefSchema,
      version: z.string().min(1),
      revision: z.number().int().positive().optional(),
      contentHash: z.string().regex(/^[a-f0-9]{64}$/),
      source: z.string().min(1),
    }),
  ),
});

export const PragmaDiagnosticSchema = z.object({
  severity: z.enum(["error", "warning"]),
  code: z.string().min(1),
  message: z.string().min(1),
  source: z.string().optional(),
  path: z.array(z.union([z.string(), z.number()])).default([]),
});

export type PragmaResourceRef = z.infer<typeof PragmaResourceRefSchema>;
export type PragmaExpertResource = z.infer<typeof PragmaExpertResourceSchema>;
export type PragmaExpertTeamResource = z.infer<typeof PragmaExpertTeamResourceSchema>;
export type PragmaFlowResource = z.infer<typeof PragmaFlowResourceSchema>;
export type PragmaResource = z.infer<typeof PragmaResourceSchema>;
export type PragmaBundle = z.infer<typeof PragmaBundleSchema>;
export type PragmaLock = z.infer<typeof PragmaLockSchema>;
export type PragmaDiagnostic = z.infer<typeof PragmaDiagnosticSchema>;
export type PragmaToolBinding = z.infer<typeof PragmaToolBindingSchema>;
export type PragmaFlowTarget = z.infer<typeof PragmaFlowTargetSchema>;
export type PragmaFlowTransition = z.infer<typeof PragmaFlowTransitionSchema>;
export type PragmaFlowDestination = z.infer<typeof PragmaFlowDestinationSchema>;
