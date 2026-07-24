import { RuntimeModelSelectionSchema } from "@pragma/shared";
import { z } from "zod";

import { PragmaObjectJsonSchemaSchema } from "./tool-capability.schema.ts";

export const PragmaApiVersionSchema = z.literal("pragma/v2");

export const PragmaResourceKindSchema = z.enum([
  "expert",
  "team",
  "flow",
  "automation",
  "capability",
  "context-store",
  "runtime-profile",
]);

const SEMANTIC_RESOURCE_ID = "[A-Za-z0-9][A-Za-z0-9_]*";
const EXTENSION_RESOURCE_ID = "[A-Za-z0-9][A-Za-z0-9._-]*";
const VERSION = "[A-Za-z0-9][A-Za-z0-9.+_-]*";

export const PRAGMA_EXPERT_ID_MAX_LENGTH = 50;

export const PragmaSemanticResourceIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(120)
  .regex(new RegExp(`^${SEMANTIC_RESOURCE_ID}$`), "Use only letters, numbers, and underscores.");

export const PragmaExpertIdSchema = PragmaSemanticResourceIdSchema.max(PRAGMA_EXPERT_ID_MAX_LENGTH);

export const PragmaFlowNodeIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/, "Use only letters, numbers, underscores, and hyphens.")
  .refine(
    (value) => !value.startsWith("__") && !["constructor", "prototype"].includes(value),
    "Flow node IDs cannot use reserved names.",
  );

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

export const PragmaExpertRefSchema = exactRefSchema(
  ["expert"],
  "expert:researcher@1.0.0",
).superRefine((value, context) => {
  const id = value.slice("expert:".length, value.lastIndexOf("@"));
  const parsed = PragmaExpertIdSchema.safeParse(id);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ["id", ...issue.path] });
  }
});
export const PragmaInvocableResourceRefSchema = z.union([
  PragmaExpertRefSchema,
  exactRefSchema(["team", "flow"], "team:delivery@1.0.0"),
]);
export const PragmaAutomationRefSchema = exactRefSchema(
  ["automation"],
  "automation:daily_report@1.0.0",
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
export const PragmaSemanticResourceRefSchema = z.union([
  PragmaExpertRefSchema,
  exactRefSchema(
    ["team", "flow", "automation", "capability", "context-store", "runtime-profile"],
    "team:delivery@1.0.0",
  ),
]);
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

export const PragmaExpertMetadataSchema = PragmaMetadataSchema.extend({
  id: PragmaExpertIdSchema,
});

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

export const PragmaRuntimeProfileConfigSchema = z
  .object({
    runtimeId: z.string().trim().min(1),
    providerId: z.string().trim().min(1).optional(),
    model: z.string().trim().min(1).optional(),
    thinkingLevel: z.string().trim().min(1).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.providerId === undefined) !== (value.model === undefined)) {
      context.addIssue({
        code: "custom",
        path: ["providerId"],
        message: "A Runtime model requires both providerId and model.",
      });
    }
    if (value.thinkingLevel !== undefined && value.model === undefined) {
      context.addIssue({
        code: "custom",
        path: ["thinkingLevel"],
        message: "A Runtime thinking level requires an explicit model.",
      });
    }
  });

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
        runtimes: z.record(PragmaExpertIdSchema, PragmaRuntimeProfileRefSchema).default({}),
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
    metadata: PragmaExpertMetadataSchema,
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
        coordinator: z.object({ ref: PragmaExpertRefSchema }).strict(),
        members: z.array(z.object({ ref: PragmaExpertRefSchema }).strict()).min(1),
        instructions: PragmaExpertInstructionsSchema.optional(),
        delegation: z
          .object({
            allow: z.record(PragmaExpertIdSchema, z.array(PragmaExpertIdSchema)).optional(),
            maxConcurrency: z.number().int().positive().default(4),
            maxDepth: z.number().int().positive().default(3),
            context: exactRefSchema(
              ["context-policy"],
              "context-policy:pragma.fresh@v1",
              EXTENSION_RESOURCE_ID,
            ).default("context-policy:pragma.fresh@v1"),
            runtimes: z.record(PragmaExpertIdSchema, PragmaRuntimeProfileRefSchema).default({}),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();

export const PragmaFlowTargetSchema = z.union([
  PragmaFlowNodeIdSchema,
  z.object({ goto: PragmaFlowNodeIdSchema }).strict(),
  z.object({ end: z.literal(true) }).strict(),
  z.object({ fail: z.string().trim().min(1) }).strict(),
]);

export const PragmaFlowRepeatTargetSchema = z
  .object({
    repeat: z.object({ loop: PragmaFlowNodeIdSchema, goto: PragmaFlowNodeIdSchema }).strict(),
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
    options: z.array(z.string().min(1)).optional(),
    approveOption: z.string().min(1).optional(),
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
  .strict()
  .superRefine((value, context) => {
    if (value.approveOption === undefined) return;
    if (value.kind !== "approval") {
      context.addIssue({
        code: "custom",
        path: ["approveOption"],
        message: "approveOption is only valid for approval HumanTask steps.",
      });
      return;
    }
    const choices = [
      ...(value.options ?? []),
      ...(value.questions ?? []).flatMap((question) => question.options),
    ];
    if (choices.length > 0 && !choices.includes(value.approveOption)) {
      context.addIssue({
        code: "custom",
        path: ["approveOption"],
        message: "approveOption must match an approval choice.",
      });
    }
  });

const PragmaFlowVariablePathSchema = z
  .array(
    z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use a JSON object field name."),
  )
  .max(5)
  .default([]);

export const PragmaFlowVariableSchema = z.discriminatedUnion("source", [
  z
    .object({
      source: z.literal("flow-input"),
      path: PragmaFlowVariablePathSchema,
    })
    .strict(),
  z
    .object({
      source: z.literal("node-output"),
      nodeId: PragmaFlowNodeIdSchema,
      path: PragmaFlowVariablePathSchema,
    })
    .strict(),
]);

export const PragmaFlowPromptSchema = z
  .object({
    segments: z
      .array(
        z.union([
          z.object({ text: z.string().max(20_000) }).strict(),
          z.object({ variable: PragmaFlowVariableSchema }).strict(),
        ]),
      )
      .max(500)
      .default([]),
  })
  .strict();

export const PragmaFlowRuntimeBindingSchema = z
  .object({
    ref: PragmaRuntimeProfileRefSchema,
    modelSelection: RuntimeModelSelectionSchema.optional(),
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
    expert: z.object({ ref: PragmaExpertRefSchema }).strict().optional(),
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
    prompt: PragmaFlowPromptSchema.optional(),
    output: z.object({ schema: PragmaObjectJsonSchemaSchema }).strict().optional(),
    context: exactRefSchema(
      ["context-policy"],
      "context-policy:pragma.fresh@v1",
      EXTENSION_RESOURCE_ID,
    ).optional(),
    runtime: PragmaFlowRuntimeBindingSchema.optional(),
    runtimes: z.record(PragmaExpertIdSchema, PragmaRuntimeProfileRefSchema).optional(),
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
    const isExpertStep = value.expert !== undefined || value.team !== undefined;
    if (isExpertStep && value.input !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["input"],
        message: "Expert and Team Flow steps use prompt segments instead of input mappings.",
      });
    }
    if (!isExpertStep && (value.prompt !== undefined || value.output !== undefined)) {
      context.addIssue({
        code: "custom",
        message: "Prompt templates and structured output are only valid for Expert and Team steps.",
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
    entry: PragmaFlowNodeIdSchema,
    maxIterations: z.number().int().positive(),
    onLimit: PragmaFlowTargetSchema.optional(),
  })
  .strict();

export const PragmaFlowGraphSchema = z
  .object({
    start: PragmaFlowNodeIdSchema,
    steps: z.record(PragmaFlowNodeIdSchema, PragmaFlowStepSchema),
    loops: z.record(PragmaFlowNodeIdSchema, PragmaFlowLoopSchema).default({}),
    transitions: z.record(PragmaFlowNodeIdSchema, PragmaFlowTransitionSchema),
  })
  .strict();

export const PragmaFlowResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Flow"),
    metadata: PragmaMetadataSchema,
    spec: z
      .object({
        input: z.object({ schema: PragmaObjectJsonSchemaSchema }).strict().optional(),
        output: z
          .object({ schema: PragmaObjectJsonSchemaSchema, value: z.unknown().optional() })
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

const PragmaAutomationTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Expected a 24-hour time such as 09:30.");

const PragmaAutomationWindowSchema = z
  .object({
    startsAt: z.string().datetime({ offset: true }).optional(),
    endsAt: z.string().datetime({ offset: true }).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.startsAt !== undefined &&
      value.endsAt !== undefined &&
      Date.parse(value.endsAt) <= Date.parse(value.startsAt)
    ) {
      context.addIssue({
        code: "custom",
        message: "Automation endsAt must be after startsAt.",
        path: ["endsAt"],
      });
    }
  });

export const PragmaScheduleTriggerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("once"),
      at: z.string().datetime({ offset: true }),
    })
    .strict(),
  z
    .object({
      kind: z.literal("interval"),
      every: z.number().int().positive(),
      unit: z.enum(["minutes", "hours", "days", "weeks"]),
      anchorAt: z.string().datetime({ offset: true }),
      window: PragmaAutomationWindowSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("calendar"),
      frequency: z.enum(["daily", "weekdays", "weekly", "monthly"]),
      time: PragmaAutomationTimeSchema,
      timezone: z.string().trim().min(1).max(100),
      weekdays: z
        .array(z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]))
        .min(1)
        .max(7)
        .optional(),
      dayOfMonth: z.number().int().min(1).max(31).optional(),
      window: PragmaAutomationWindowSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (value.frequency === "weekly" && value.weekdays === undefined) {
        context.addIssue({
          code: "custom",
          message: "Weekly schedules require at least one weekday.",
          path: ["weekdays"],
        });
      }
      if (value.frequency !== "weekly" && value.weekdays !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Only weekly schedules accept weekdays.",
          path: ["weekdays"],
        });
      }
      if (value.frequency === "monthly" && value.dayOfMonth === undefined) {
        context.addIssue({
          code: "custom",
          message: "Monthly schedules require dayOfMonth.",
          path: ["dayOfMonth"],
        });
      }
      if (value.frequency !== "monthly" && value.dayOfMonth !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Only monthly schedules accept dayOfMonth.",
          path: ["dayOfMonth"],
        });
      }
    }),
  z
    .object({
      kind: z.literal("cron"),
      expression: z
        .string()
        .trim()
        .refine(
          (value) => value.split(/\s+/).length === 5,
          "Automation Cron expressions must use five fields.",
        ),
      timezone: z.string().trim().min(1).max(100),
      window: PragmaAutomationWindowSchema.optional(),
    })
    .strict(),
]);

export const PragmaScheduleAutomationConfigSchema = z
  .object({
    trigger: PragmaScheduleTriggerSchema,
  })
  .strict();

export const PragmaAutomationResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Automation"),
    metadata: PragmaMetadataSchema,
    spec: z
      .object({
        adapter: PragmaExtensionRefSchema,
        binding: PragmaBindingRefSchema,
        config: z.unknown().default({}),
        enabled: z.boolean().default(true),
        route: z
          .object({
            executor: z.object({ ref: PragmaInvocableResourceRefSchema }).strict(),
            input: z.discriminatedUnion("kind", [
              z
                .object({
                  kind: z.literal("prompt"),
                  value: z.string().trim().min(1).max(100_000),
                })
                .strict(),
              z
                .object({
                  kind: z.literal("flow"),
                  value: z.record(z.string(), z.unknown()),
                })
                .strict(),
            ]),
          })
          .strict(),
        interaction: z
          .object({
            mode: z.enum(["reuse-session", "new-mission"]).default("reuse-session"),
          })
          .strict()
          .default({ mode: "reuse-session" }),
        delivery: z
          .object({
            adapter: PragmaExtensionRefSchema.default("pragma.automation.delivery.local@v1"),
          })
          .strict()
          .default({ adapter: "pragma.automation.delivery.local@v1" }),
      })
      .strict(),
  })
  .strict()
  .superRefine((resource, context) => {
    const flow = resource.spec.route.executor.ref.startsWith("flow:");
    if (flow && resource.spec.route.input.kind !== "flow") {
      context.addIssue({
        code: "custom",
        message: "Flow automations require structured Flow input.",
        path: ["spec", "route", "input"],
      });
    }
    if (!flow && resource.spec.route.input.kind !== "prompt") {
      context.addIssue({
        code: "custom",
        message: "Expert and Team automations require prompt input.",
        path: ["spec", "route", "input"],
      });
    }
    if (flow && resource.spec.interaction.mode !== "new-mission") {
      context.addIssue({
        code: "custom",
        message: "Flow automations must create a new Mission for every event.",
        path: ["spec", "interaction", "mode"],
      });
    }
    if (resource.spec.adapter === "pragma.automation.schedule@v1") {
      const parsed = PragmaScheduleAutomationConfigSchema.safeParse(resource.spec.config);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          context.addIssue({
            ...issue,
            path: ["spec", "config", ...issue.path],
          });
        }
      }
    }
  });

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
  PragmaAutomationResourceSchema,
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaRuntimeProfileResourceSchema,
]);

export const PragmaResourceSchema = z.discriminatedUnion("kind", [
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
  PragmaAutomationResourceSchema,
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
export type PragmaAutomationResource = z.infer<typeof PragmaAutomationResourceSchema>;
export type PragmaScheduleTrigger = z.infer<typeof PragmaScheduleTriggerSchema>;
export type PragmaScheduleAutomationConfig = z.infer<typeof PragmaScheduleAutomationConfigSchema>;
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
export type PragmaFlowPrompt = z.infer<typeof PragmaFlowPromptSchema>;
export type PragmaFlowVariable = z.infer<typeof PragmaFlowVariableSchema>;
export type PragmaRuntimeProfileConfig = z.infer<typeof PragmaRuntimeProfileConfigSchema>;
export type PragmaHumanRequest = z.infer<typeof PragmaHumanRequestSchema>;
