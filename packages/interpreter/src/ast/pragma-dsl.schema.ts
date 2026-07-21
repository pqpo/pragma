import { z } from "zod";

export const PragmaApiVersionSchema = z.literal("pragma/v2");

export const PragmaResourceKindSchema = z.enum([
  "expert",
  "team",
  "flow",
  "capability",
  "context-store",
  "runtime-profile",
]);

const SEMANTIC_RESOURCE_ID = "[A-Za-z0-9][A-Za-z0-9_]*";
const EXTENSION_RESOURCE_ID = "[A-Za-z0-9][A-Za-z0-9._-]*";
const VERSION = "[A-Za-z0-9][A-Za-z0-9.+_-]*";

export const PragmaSemanticResourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(new RegExp(`^${SEMANTIC_RESOURCE_ID}$`), "Use only letters, numbers, and underscores.");

function exactRefSchema(
  kinds: readonly string[],
  example: string,
  resourceId: string = SEMANTIC_RESOURCE_ID,
) {
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^(${kinds.join("|")}):${resourceId}@${VERSION}$`),
      `Expected an exact Pragma reference such as ${example}.`,
    );
}

export const PragmaInvocableResourceRefSchema = exactRefSchema(
  ["expert", "team", "flow"],
  "expert:researcher@1.0.0",
);
export const PragmaCapabilityRefSchema = exactRefSchema(
  ["capability"],
  "capability:repository_tools@1.0.0",
);
export const PragmaContextStoreRefSchema = exactRefSchema(
  ["context-store"],
  "context-store:project_docs@1.0.0",
);
export const PragmaRuntimeProfileRefSchema = exactRefSchema(
  ["runtime-profile"],
  "runtime-profile:desktop_codex@1.0.0",
);
export const PragmaSemanticResourceRefSchema = exactRefSchema(
  ["expert", "team", "flow", "capability", "context-store", "runtime-profile"],
  "expert:researcher@1.0.0",
);
export const PragmaExtensionResourceRefSchema = exactRefSchema(
  ["action", "context-policy", "plugin"],
  "context-policy:pragma.fresh@v1",
  EXTENSION_RESOURCE_ID,
);
export const PragmaResourceRefSchema = z.union([
  PragmaSemanticResourceRefSchema,
  PragmaExtensionResourceRefSchema,
]);

export const PragmaBindingRefSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^binding:${EXTENSION_RESOURCE_ID}$`),
    "Expected a binding reference such as binding:github.",
  );

export const PragmaExtensionRefSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^${EXTENSION_RESOURCE_ID}@${VERSION}$`),
    "Expected a versioned adapter reference such as pragma.capability.mcp@v1.",
  );

export const PragmaMetadataSchema = z
  .object({
    id: PragmaSemanticResourceIdSchema,
    version: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(new RegExp(`^${VERSION}$`)),
    name: z.string().trim().min(1).max(200),
    description: z.string().trim().min(1).max(4_000),
    tags: z.array(z.string().trim().min(1).max(100)).max(100).default([]),
  })
  .strict();

export const PRAGMA_EXPERT_SCOPE_MAX_LENGTH = 500;
export const PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH = 2_000;

function unicodeLength(value: string): number {
  return [...value].length;
}

export const PragmaExpertScopeSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => unicodeLength(value) <= PRAGMA_EXPERT_SCOPE_MAX_LENGTH, {
    message: `Must contain at most ${PRAGMA_EXPERT_SCOPE_MAX_LENGTH} characters.`,
  });

export const PragmaExpertInstructionsSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => unicodeLength(value) <= PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH, {
    message: `Must contain at most ${PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH} characters.`,
  });

export const PragmaArtifactSourceSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("project"),
      path: z.string().trim().min(1).max(2_000),
    })
    .strict(),
  z
    .object({
      type: z.enum(["registry", "uri"]),
      uri: z.string().trim().min(1).max(4_000),
      integrity: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    })
    .strict(),
]);

export const PragmaAdapterResourceSpecSchema = z
  .object({
    adapter: PragmaExtensionRefSchema,
    binding: PragmaBindingRefSchema.optional(),
    config: z.unknown().default({}),
  })
  .strict();

export const PragmaToolBindingSchema = z
  .object({
    adapter: PragmaExtensionRefSchema,
    target: z.object({ ref: PragmaInvocableResourceRefSchema }).strict().optional(),
    targets: z
      .array(z.object({ ref: PragmaInvocableResourceRefSchema }).strict())
      .min(1)
      .optional(),
    tool: z
      .object({
        name: z.string().trim().min(1).max(128),
        description: z.string().trim().min(1).max(4_000),
        approval: z.enum(["none", "ask", "required"]).default("none"),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
    policy: z
      .object({
        maxConcurrency: z.number().int().positive().default(4),
        maxDepth: z.number().int().positive().default(3),
        context: exactRefSchema(
          ["context-policy"],
          "context-policy:pragma.fresh@v1",
          EXTENSION_RESOURCE_ID,
        ).default("context-policy:pragma.fresh@v1"),
        runtimes: z.record(z.string().min(1), PragmaRuntimeProfileRefSchema).default({}),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.target === undefined) === (value.targets === undefined)) {
      context.addIssue({
        code: "custom",
        message: "A tool binding must declare exactly one of target or targets.",
      });
    }
  });

export const PragmaExpertResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Expert"),
    metadata: PragmaMetadataSchema,
    spec: z
      .object({
        scope: PragmaExpertScopeSchema,
        instructions: PragmaExpertInstructionsSchema,
        runtime: z.object({ ref: PragmaRuntimeProfileRefSchema }).strict().optional(),
        capabilities: z
          .array(
            z
              .object({
                ref: PragmaCapabilityRefSchema,
                kind: z.enum(["skill", "tools"]),
                tools: z.array(z.string().trim().min(1).max(128)).optional(),
              })
              .strict(),
          )
          .default([]),
        toolApprovals: z
          .record(z.string().max(200), z.enum(["none", "ask", "required"]))
          .default({}),
        contextStores: z
          .array(
            z
              .object({
                ref: PragmaContextStoreRefSchema,
                namespace: z
                  .string()
                  .trim()
                  .min(1)
                  .max(100)
                  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
                required: z.boolean().default(false),
              })
              .strict(),
          )
          .default([]),
        plugins: z
          .array(
            z
              .object({
                ref: exactRefSchema(
                  ["plugin"],
                  "plugin:pragma.memory@1.0.0",
                  EXTENSION_RESOURCE_ID,
                ),
                config: z.record(z.string(), z.unknown()).optional(),
                secretBindings: z.record(z.string(), PragmaBindingRefSchema).optional(),
              })
              .strict(),
          )
          .default([]),
        tools: z.array(PragmaToolBindingSchema).default([]),
      })
      .strict(),
  })
  .strict()
  .superRefine((expert, context) => {
    const pluginIds = new Set<string>();
    expert.spec.plugins.forEach((plugin, index) => {
      const pluginId = plugin.ref.slice("plugin:".length, plugin.ref.lastIndexOf("@"));
      if (pluginIds.has(pluginId)) {
        context.addIssue({
          code: "custom",
          message: `An Expert can activate only one version of plugin ${pluginId}.`,
          path: ["spec", "plugins", index, "ref"],
        });
      }
      pluginIds.add(pluginId);
    });
  });

export const PragmaExpertTeamResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("ExpertTeam"),
    metadata: PragmaMetadataSchema,
    spec: z
      .object({
        coordinator: z.object({ ref: exactRefSchema(["expert"], "expert:lead@1.0.0") }).strict(),
        members: z
          .array(z.object({ ref: exactRefSchema(["expert"], "expert:worker@1.0.0") }).strict())
          .min(1),
        instructions: PragmaExpertInstructionsSchema.optional(),
        delegation: z
          .object({
            allow: z.record(z.string().min(1), z.array(z.string().min(1))).optional(),
            maxConcurrency: z.number().int().positive().default(4),
            maxDepth: z.number().int().positive().default(3),
            context: exactRefSchema(
              ["context-policy"],
              "context-policy:pragma.fresh@v1",
              EXTENSION_RESOURCE_ID,
            ).default("context-policy:pragma.fresh@v1"),
            runtimes: z.record(z.string().min(1), PragmaRuntimeProfileRefSchema).default({}),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const PragmaFlowTargetSchema = z.union([
  z.string().trim().min(1),
  z.object({ goto: z.string().trim().min(1) }).strict(),
  z.object({ end: z.literal(true) }).strict(),
  z.object({ fail: z.string().trim().min(1) }).strict(),
]);

export const PragmaFlowRepeatTargetSchema = z
  .object({
    repeat: z.object({ loop: z.string().trim().min(1), goto: z.string().trim().min(1) }).strict(),
  })
  .strict();

export const PragmaFlowDestinationSchema = z.union([
  PragmaFlowTargetSchema,
  PragmaFlowRepeatTargetSchema,
]);

export const PragmaHumanRequestSchema = z
  .object({
    kind: z.enum(["approval", "question", "review_gate", "manual_intervention"]),
    title: z.string().min(1).optional(),
    prompt: z.string().optional(),
    questions: z
      .array(
        z
          .object({
            id: z.string().trim().min(1),
            type: z.enum(["single_choice", "multiple_choice", "text"]),
            label: z.string().min(1),
            options: z.array(z.string()).default([]),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();

export const PragmaFlowStepSchema = z
  .object({
    action: z
      .object({
        ref: exactRefSchema(["action"], "action:review@1.0.0", EXTENSION_RESOURCE_ID),
      })
      .strict()
      .optional(),
    expert: z
      .object({ ref: exactRefSchema(["expert"], "expert:reviewer@1.0.0") })
      .strict()
      .optional(),
    team: z
      .object({ ref: exactRefSchema(["team"], "team:delivery@1.0.0") })
      .strict()
      .optional(),
    flow: z
      .object({ ref: exactRefSchema(["flow"], "flow:review@1.0.0") })
      .strict()
      .optional(),
    human: PragmaHumanRequestSchema.optional(),
    version: z.string().trim().min(1).default("1.0.0"),
    input: z.unknown().optional(),
    save: z
      .string()
      .trim()
      .regex(/^state\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*$/)
      .optional(),
    context: exactRefSchema(
      ["context-policy"],
      "context-policy:pragma.fresh@v1",
      EXTENSION_RESOURCE_ID,
    ).optional(),
    runtime: PragmaRuntimeProfileRefSchema.optional(),
    runtimes: z.record(z.string().min(1), PragmaRuntimeProfileRefSchema).optional(),
  })
  .strict()
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
    const statePath = value.save?.slice("state.".length).split(".") ?? [];
    const forbidden = statePath.find((segment) =>
      new Set(["__proto__", "prototype", "constructor"]).has(segment),
    );
    if (forbidden !== undefined || statePath[0]?.startsWith("__") === true) {
      context.addIssue({
        code: "custom",
        path: ["save"],
        message: "Flow save paths cannot use reserved or prototype-sensitive state segments.",
      });
    }
    if (
      (value.action !== undefined || value.human !== undefined) &&
      (value.context !== undefined || value.runtime !== undefined || value.runtimes !== undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Action and human Flow steps cannot declare context or Runtime routing fields.",
      });
    }
    if (value.flow !== undefined && (value.context !== undefined || value.runtimes !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Nested Flow steps only support the runtime fallback override.",
      });
    }
  });

export const PragmaFlowTransitionSchema = z.union([
  PragmaFlowDestinationSchema,
  z
    .object({
      route: z.string().trim().min(1),
      cases: z.record(z.string(), PragmaFlowDestinationSchema),
      fallback: PragmaFlowDestinationSchema.optional(),
    })
    .strict(),
]);

export const PragmaFlowLoopSchema = z
  .object({
    entry: z.string().trim().min(1),
    maxIterations: z.number().int().positive(),
    onLimit: PragmaFlowTargetSchema.optional(),
  })
  .strict();

export const PragmaFlowGraphSchema = z
  .object({
    start: z.string().trim().min(1),
    steps: z.record(z.string().trim().min(1), PragmaFlowStepSchema),
    loops: z.record(z.string().trim().min(1), PragmaFlowLoopSchema).default({}),
    transitions: z.record(z.string().trim().min(1), PragmaFlowTransitionSchema),
  })
  .strict();

export const PragmaFlowResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Flow"),
    metadata: PragmaMetadataSchema,
    spec: z
      .object({
        input: z.object({ schema: z.unknown().optional() }).strict().optional(),
        output: z
          .object({ schema: z.unknown().optional(), value: z.unknown().optional() })
          .strict()
          .optional(),
        limits: z
          .object({
            maxNodeVisits: z.number().int().positive().default(1_000),
            timeoutMs: z.number().int().positive().optional(),
          })
          .strict()
          .default({ maxNodeVisits: 1_000 }),
        graph: PragmaFlowGraphSchema,
      })
      .strict(),
  })
  .strict();

export const PragmaCapabilityResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Capability"),
    metadata: PragmaMetadataSchema,
    spec: PragmaAdapterResourceSpecSchema,
  })
  .strict();

export const PragmaContextStoreResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("ContextStore"),
    metadata: PragmaMetadataSchema,
    spec: PragmaAdapterResourceSpecSchema,
  })
  .strict();

export const PragmaRuntimeProfileResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("RuntimeProfile"),
    metadata: PragmaMetadataSchema,
    spec: PragmaAdapterResourceSpecSchema,
  })
  .strict();

export const PragmaInvocableResourceSchema = z.discriminatedUnion("kind", [
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
]);

export const PragmaDeclarativeResourceSchema = z.discriminatedUnion("kind", [
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaRuntimeProfileResourceSchema,
]);

export const PragmaResourceSchema = z.discriminatedUnion("kind", [
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaRuntimeProfileResourceSchema,
]);

export const PragmaBundleSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaResourceSchema).default([]),
  })
  .strict();

export const PragmaLockSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Lock"),
    compilerVersion: z.string().min(1),
    projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    resources: z.array(
      z
        .object({
          ref: PragmaSemanticResourceRefSchema,
          contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          source: z.string().min(1),
        })
        .strict(),
    ),
    artifacts: z
      .array(
        z
          .object({
            source: z.string().min(1),
            contentHash: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export const PragmaDiagnosticSchema = z
  .object({
    severity: z.enum(["error", "warning"]),
    code: z.string().min(1),
    message: z.string().min(1),
    source: z.string().optional(),
    path: z.array(z.union([z.string(), z.number()])).default([]),
  })
  .strict();

export const PragmaResourceHealthSchema = z
  .object({
    ref: PragmaSemanticResourceRefSchema,
    resourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    bindingRevision: z.string().min(1).optional(),
    adapter: PragmaExtensionRefSchema,
    status: z.enum(["ready", "needs_attention"]),
    verificationFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    checkedAt: z.string().datetime(),
    issues: z.array(PragmaDiagnosticSchema).default([]),
  })
  .strict();

export const PragmaEnvironmentFingerprintSchema = z
  .object({
    environmentId: z.string().trim().min(1).max(200),
    projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
    value: z.string().regex(/^[a-f0-9]{64}$/),
    resources: z.array(
      z
        .object({
          ref: PragmaSemanticResourceRefSchema,
          bindingRevision: z.string().min(1).optional(),
          verificationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
        })
        .strict(),
    ),
    plugins: z
      .array(
        z
          .object({
            expertRef: exactRefSchema(["expert"], "expert:lead@1.0.0"),
            ref: exactRefSchema(["plugin"], "plugin:pragma.memory@1.0.0", EXTENSION_RESOURCE_ID),
            packageFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
            verificationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export type PragmaResourceRef = z.infer<typeof PragmaResourceRefSchema>;
export type PragmaSemanticResourceRef = z.infer<typeof PragmaSemanticResourceRefSchema>;
export type PragmaInvocableResourceRef = z.infer<typeof PragmaInvocableResourceRefSchema>;
export type PragmaBindingRef = z.infer<typeof PragmaBindingRefSchema>;
export type PragmaArtifactSource = z.infer<typeof PragmaArtifactSourceSchema>;
export type PragmaExpertResource = z.infer<typeof PragmaExpertResourceSchema>;
export type PragmaExpertTeamResource = z.infer<typeof PragmaExpertTeamResourceSchema>;
export type PragmaFlowResource = z.infer<typeof PragmaFlowResourceSchema>;
export type PragmaCapabilityResource = z.infer<typeof PragmaCapabilityResourceSchema>;
export type PragmaContextStoreResource = z.infer<typeof PragmaContextStoreResourceSchema>;
export type PragmaRuntimeProfileResource = z.infer<typeof PragmaRuntimeProfileResourceSchema>;
export type PragmaInvocableResource = z.infer<typeof PragmaInvocableResourceSchema>;
export type PragmaDeclarativeResource = z.infer<typeof PragmaDeclarativeResourceSchema>;
export type PragmaResource = z.infer<typeof PragmaResourceSchema>;
export type PragmaBundle = z.infer<typeof PragmaBundleSchema>;
export type PragmaLock = z.infer<typeof PragmaLockSchema>;
export type PragmaDiagnostic = z.infer<typeof PragmaDiagnosticSchema>;
export type PragmaResourceHealth = z.infer<typeof PragmaResourceHealthSchema>;
export type PragmaEnvironmentFingerprint = z.infer<typeof PragmaEnvironmentFingerprintSchema>;
export type PragmaToolBinding = z.infer<typeof PragmaToolBindingSchema>;
export type PragmaFlowTarget = z.infer<typeof PragmaFlowTargetSchema>;
export type PragmaFlowTransition = z.infer<typeof PragmaFlowTransitionSchema>;
export type PragmaFlowDestination = z.infer<typeof PragmaFlowDestinationSchema>;
export type PragmaHumanRequest = z.infer<typeof PragmaHumanRequestSchema>;
