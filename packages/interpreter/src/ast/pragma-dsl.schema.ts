import {
  DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
  DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID,
  PRAGMA_TEXT_LIMITS,
  PragmaAvatarIdSchema,
  RuntimeModelSelectionSchema,
  pragmaUnicodeLength,
} from "@pragma/shared";
import {
  PragmaAgentJudgeEvaluationSpecSchema,
  PragmaEvaluationMetadataSchema,
  PragmaFlowRunDryEvaluationSpecSchema,
} from "@pragma/evaluation/ast";
import { z } from "zod";

import { PRAGMA_DSL_WRITE_API_VERSION, PragmaApiVersionSchema } from "./pragma-api-version.ts";
import { PragmaObjectJsonSchemaSchema } from "./tool-capability.schema.ts";

export { PRAGMA_DSL_WRITE_API_VERSION, PragmaApiVersionSchema };

export const PragmaFlowRunDryEvaluationResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Evaluation"),
    metadata: PragmaEvaluationMetadataSchema,
    spec: PragmaFlowRunDryEvaluationSpecSchema,
  })
  .strict();

export const PragmaAgentJudgeEvaluationResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Evaluation"),
    metadata: PragmaEvaluationMetadataSchema,
    spec: PragmaAgentJudgeEvaluationSpecSchema,
  })
  .strict();

export const PragmaEvaluationResourceSchema = z.union([
  PragmaFlowRunDryEvaluationResourceSchema,
  PragmaAgentJudgeEvaluationResourceSchema,
]);

export const PragmaResourceKindSchema = z.enum([
  "expert",
  "team",
  "flow",
  "automation",
  "capability",
  "context-store",
  "runtime-profile",
  "evaluation",
]);

const SEMANTIC_RESOURCE_ID = "[0-9a-hjkmnp-tv-z]{16}";
const EXTENSION_RESOURCE_ID = "[A-Za-z0-9][A-Za-z0-9._-]*";
const VERSION = "[A-Za-z0-9][A-Za-z0-9.+_-]*";

export const PragmaSemanticResourceIdSchema = z
  .string()
  .trim()
  .regex(
    new RegExp(`^${SEMANTIC_RESOURCE_ID}$`),
    "Expected a 16-character lowercase Crockford Base32 resource ID.",
  );

export const PragmaExpertIdSchema = PragmaSemanticResourceIdSchema;

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

function semanticRefSchema(kinds: readonly string[], example: string) {
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^(${kinds.join("|")}):${SEMANTIC_RESOURCE_ID}$`, "i"),
      `Expected an exact Pragma reference such as ${example}.`,
    );
}

function versionedExtensionRefSchema(
  kinds: readonly string[],
  example: string,
  resourceId: string = EXTENSION_RESOURCE_ID,
) {
  return z
    .string()
    .trim()
    .regex(
      new RegExp(`^(${kinds.join("|")}):${resourceId}@${VERSION}$`),
      `Expected a versioned extension reference such as ${example}.`,
    );
}

export const PragmaExpertRefSchema = semanticRefSchema(
  ["expert"],
  "expert:7k2m9q4v8np6r3dt",
).superRefine((value, context) => {
  const id = value.slice("expert:".length);
  const parsed = PragmaExpertIdSchema.safeParse(id);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ["id", ...issue.path] });
  }
});
export const PragmaExpertTeamRefSchema = semanticRefSchema(["team"], "team:7k2m9q4v8np6r3dt");
export const PragmaInvocableResourceRefSchema = z.union([
  PragmaExpertRefSchema,
  PragmaExpertTeamRefSchema,
  semanticRefSchema(["flow"], "flow:7k2m9q4v8np6r3dt"),
]);
export const PragmaAutomationRefSchema = semanticRefSchema(
  ["automation"],
  "automation:7k2m9q4v8np6r3dt",
);
export const PragmaCapabilityRefSchema = semanticRefSchema(
  ["capability"],
  "capability:7k2m9q4v8np6r3dt",
);
export const PragmaContextStoreRefSchema = semanticRefSchema(
  ["context-store"],
  "context-store:7k2m9q4v8np6r3dt",
);
export const PragmaRuntimeProfileRefSchema = semanticRefSchema(
  ["runtime-profile"],
  "runtime-profile:7k2m9q4v8np6r3dt",
);
export const PragmaSemanticResourceRefSchema = z.union([
  PragmaExpertRefSchema,
  semanticRefSchema(
    ["team", "flow", "automation", "capability", "context-store", "runtime-profile", "evaluation"],
    "team:7k2m9q4v8np6r3dt",
  ),
]);
export const PragmaExtensionResourceRefSchema = versionedExtensionRefSchema(
  ["action", "context-policy", "plugin"],
  "context-policy:pragma.fresh@v1",
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
    name: z.string().trim().min(1).max(PRAGMA_TEXT_LIMITS.defaultMetadata.name),
    description: z.string().trim().min(1).max(PRAGMA_TEXT_LIMITS.defaultMetadata.description),
    tags: z
      .array(z.string().trim().min(1).max(PRAGMA_TEXT_LIMITS.defaultMetadata.tag))
      .max(PRAGMA_TEXT_LIMITS.defaultMetadata.tags)
      .default([]),
  })
  .strict();

function requiredUnicodeText(maxLength: number) {
  return z
    .string()
    .trim()
    .min(1)
    .refine((value) => pragmaUnicodeLength(value) <= maxLength, {
      message: `Must contain at most ${maxLength} characters.`,
    });
}

function metadataSchema(
  limits: { readonly name: number; readonly description: number },
  tags = PragmaMetadataSchema.shape.tags,
) {
  return PragmaMetadataSchema.extend({
    name: requiredUnicodeText(limits.name),
    description: requiredUnicodeText(limits.description),
    tags,
  });
}

export const PragmaExpertMetadataSchema = metadataSchema(
  PRAGMA_TEXT_LIMITS.expert,
  z
    .array(requiredUnicodeText(PRAGMA_TEXT_LIMITS.expert.tag))
    .max(PRAGMA_TEXT_LIMITS.expert.tags)
    .default([]),
).extend({
  id: PragmaExpertIdSchema,
  avatarId: PragmaAvatarIdSchema.default(DEFAULT_PRAGMA_EXPERT_AVATAR_ID),
});
export const PragmaExpertTeamMetadataSchema = metadataSchema(PRAGMA_TEXT_LIMITS.expertTeam).extend({
  avatarId: PragmaAvatarIdSchema.default(DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID),
});
export const PragmaFlowMetadataSchema = metadataSchema(PRAGMA_TEXT_LIMITS.flow);
export const PragmaAutomationMetadataSchema = metadataSchema(PRAGMA_TEXT_LIMITS.automation);
export const PragmaCapabilityMetadataSchema = metadataSchema(PRAGMA_TEXT_LIMITS.capability);
export const PragmaContextStoreMetadataSchema = metadataSchema(PRAGMA_TEXT_LIMITS.contextStore);

export const PragmaExpertScopeSchema = requiredUnicodeText(PRAGMA_TEXT_LIMITS.expert.scope);
export const PragmaExpertInstructionsSchema = requiredUnicodeText(
  PRAGMA_TEXT_LIMITS.expert.instructions,
);
export const PragmaExpertTeamInstructionsSchema = requiredUnicodeText(
  PRAGMA_TEXT_LIMITS.expertTeam.instructions,
);

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
        context: versionedExtensionRefSchema(
          ["context-policy"],
          "context-policy:pragma.fresh@v1",
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
        toolPolicy: z
          .object({
            allowedTools: z.array(z.string().trim().min(1).max(200)).min(1).optional(),
            deniedTools: z.array(z.string().trim().min(1).max(200)).min(1).optional(),
          })
          .strict()
          .optional(),
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
                ref: versionedExtensionRefSchema(["plugin"], "plugin:example@1.0.0"),
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

export const PragmaExpertTeamContextVisibilitySchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("all") }).strict(),
  z
    .object({
      mode: z.literal("blacklist"),
      expertIds: z.array(PragmaExpertIdSchema),
    })
    .strict(),
  z
    .object({
      mode: z.literal("whitelist"),
      expertIds: z.array(PragmaExpertIdSchema).min(1),
    })
    .strict(),
]);

export const PragmaExpertTeamContextStoreBindingSchema = z
  .object({
    ref: PragmaContextStoreRefSchema,
    namespace: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/),
    required: z.boolean().default(true),
    visibility: PragmaExpertTeamContextVisibilitySchema.default({ mode: "all" }),
  })
  .strict();

export const PragmaExpertTeamResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("ExpertTeam"),
    metadata: PragmaExpertTeamMetadataSchema,
    spec: z
      .object({
        coordinator: z.object({ ref: PragmaExpertRefSchema }).strict(),
        members: z.array(z.object({ ref: PragmaExpertRefSchema }).strict()).min(1),
        instructions: PragmaExpertTeamInstructionsSchema.optional(),
        contextStores: z.array(PragmaExpertTeamContextStoreBindingSchema).default([]),
        delegation: z
          .object({
            permissions: z
              .object({
                spawn: z.record(PragmaExpertIdSchema, z.array(PragmaExpertIdSchema)).optional(),
                interact: z.record(PragmaExpertIdSchema, z.array(PragmaExpertIdSchema)).default({}),
              })
              .strict()
              .default({ interact: {} }),
            maxConcurrency: z.number().int().positive().default(4),
            maxDepth: z.number().int().positive().default(3),
            context: versionedExtensionRefSchema(
              ["context-policy"],
              "context-policy:pragma.fresh@v1",
            ).default("context-policy:pragma.fresh@v1"),
            runtimes: z.record(PragmaExpertIdSchema, PragmaRuntimeProfileRefSchema).default({}),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .superRefine((team, context) => {
    const coordinatorId = team.spec.coordinator.ref.slice("expert:".length);
    const participantIds = [
      coordinatorId,
      ...team.spec.members.map((member) => member.ref.slice("expert:".length)),
    ];
    const participants = new Set(participantIds);
    const refs = new Set<string>();
    const namespaces = new Set<string>();
    team.spec.contextStores.forEach((binding, bindingIndex) => {
      if (refs.has(binding.ref)) {
        context.addIssue({
          code: "custom",
          message: `ExpertTeam context store is mounted more than once: ${binding.ref}.`,
          path: ["spec", "contextStores", bindingIndex, "ref"],
        });
      }
      refs.add(binding.ref);
      if (namespaces.has(binding.namespace)) {
        context.addIssue({
          code: "custom",
          message: `ExpertTeam context namespace is duplicated: ${binding.namespace}.`,
          path: ["spec", "contextStores", bindingIndex, "namespace"],
        });
      }
      namespaces.add(binding.namespace);
      if (binding.visibility.mode === "all") return;
      const selected = new Set<string>();
      binding.visibility.expertIds.forEach((expertId, expertIndex) => {
        if (!participants.has(expertId)) {
          context.addIssue({
            code: "custom",
            message: `ExpertTeam context visibility references an unknown Expert: ${expertId}.`,
            path: ["spec", "contextStores", bindingIndex, "visibility", "expertIds", expertIndex],
          });
        }
        if (selected.has(expertId)) {
          context.addIssue({
            code: "custom",
            message: `ExpertTeam context visibility contains a duplicate Expert: ${expertId}.`,
            path: ["spec", "contextStores", bindingIndex, "visibility", "expertIds", expertIndex],
          });
        }
        selected.add(expertId);
      });
      const visibleCount =
        binding.visibility.mode === "whitelist"
          ? participantIds.filter((id) => selected.has(id)).length
          : participantIds.filter((id) => !selected.has(id)).length;
      if (visibleCount === 0) {
        context.addIssue({
          code: "custom",
          message: "An ExpertTeam context store must be visible to at least one participant.",
          path: ["spec", "contextStores", bindingIndex, "visibility"],
        });
      }
    });
    for (const permission of ["spawn", "interact"] as const) {
      const configured = team.spec.delegation.permissions[permission] ?? {};
      for (const [source, targets] of Object.entries(configured)) {
        if (source === coordinatorId) {
          context.addIssue({
            code: "custom",
            message: `ExpertTeam ${permission} permission must not configure the coordinator; coordinator authority is system-inherited.`,
            path: ["spec", "delegation", "permissions", permission, source],
          });
        }
        if (!participants.has(source)) {
          context.addIssue({
            code: "custom",
            message: `ExpertTeam ${permission} permission references an unknown source Expert: ${source}.`,
            path: ["spec", "delegation", "permissions", permission, source],
          });
        }
        const seen = new Set<string>();
        targets.forEach((target, targetIndex) => {
          if (!participants.has(target)) {
            context.addIssue({
              code: "custom",
              message: `ExpertTeam ${permission} permission references an unknown target Expert: ${target}.`,
              path: ["spec", "delegation", "permissions", permission, source, targetIndex],
            });
          }
          if (seen.has(target)) {
            context.addIssue({
              code: "custom",
              message: `ExpertTeam ${permission} permission contains a duplicate target: ${target}.`,
              path: ["spec", "delegation", "permissions", permission, source, targetIndex],
            });
          }
          if (permission === "spawn" && source === target) {
            context.addIssue({
              code: "custom",
              message: `ExpertTeam spawn permission cannot target itself: ${source}.`,
              path: ["spec", "delegation", "permissions", permission, source, targetIndex],
            });
          }
          seen.add(target);
        });
      }
    }
  });

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
          z
            .object({
              text: z
                .string()
                .refine(
                  (value) =>
                    pragmaUnicodeLength(value.trim()) <= PRAGMA_TEXT_LIMITS.flow.promptTextSegment,
                  {
                    message: `Must contain at most ${PRAGMA_TEXT_LIMITS.flow.promptTextSegment} characters.`,
                  },
                ),
            })
            .strict(),
          z.object({ variable: PragmaFlowVariableSchema }).strict(),
        ]),
      )
      .max(500)
      .default([]),
  })
  .strict();

export const PragmaHumanRequestSchema = z
  .object({
    selectionMode: z.enum(["single", "multiple"]),
    prompt: PragmaFlowPromptSchema,
    options: z
      .array(
        z
          .object({
            value: z.string().trim().min(1).max(200),
            label: z.string().trim().min(1).max(500),
            description: z.string().trim().max(2_000).optional(),
          })
          .strict(),
      )
      .min(2)
      .max(100),
  })
  .strict()
  .superRefine((value, context) => {
    const values = new Set<string>();
    const labels = new Set<string>();
    value.options.forEach((option, index) => {
      if (values.has(option.value)) {
        context.addIssue({
          code: "custom",
          path: ["options", index, "value"],
          message: "Human input option values must be unique.",
        });
      }
      if (labels.has(option.label)) {
        context.addIssue({
          code: "custom",
          path: ["options", index, "label"],
          message: "Human input option labels must be unique.",
        });
      }
      values.add(option.value);
      labels.add(option.label);
    });
  });

export const PragmaFlowArrayRouteBranchSchema = z
  .object({
    id: PragmaFlowNodeIdSchema,
    operator: z.enum(["contains_any", "contains_all", "contains_none"]),
    values: z.array(z.string().min(1)).min(1),
    destination: PragmaFlowDestinationSchema,
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
        ref: versionedExtensionRefSchema(["action"], "action:review@1.0.0"),
      })
      .strict()
      .optional(),
    expert: z.object({ ref: PragmaExpertRefSchema }).strict().optional(),
    team: z
      .object({
        ref: semanticRefSchema(["team"], "team:7k2m9q4v8np6r3dt"),
      })
      .strict()
      .optional(),
    flow: z
      .object({
        ref: semanticRefSchema(["flow"], "flow:7k2m9q4v8np6r3dt"),
      })
      .strict()
      .optional(),
    human: PragmaHumanRequestSchema.optional(),
    input: z.unknown().optional(),
    prompt: PragmaFlowPromptSchema.optional(),
    output: z.object({ schema: PragmaObjectJsonSchemaSchema }).strict().optional(),
    context: versionedExtensionRefSchema(
      ["context-policy"],
      "context-policy:pragma.fresh@v1",
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
  z
    .object({
      route: z.string().trim().min(1),
      branches: z.array(PragmaFlowArrayRouteBranchSchema).min(1),
      fallback: PragmaFlowDestinationSchema.optional(),
    })
    .strict()
    .superRefine((value, context) => {
      const ids = new Set<string>();
      value.branches.forEach((branch, index) => {
        if (ids.has(branch.id)) {
          context.addIssue({
            code: "custom",
            path: ["branches", index, "id"],
            message: "Logic branch ids must be unique.",
          });
        }
        ids.add(branch.id);
      });
    }),
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
    metadata: PragmaFlowMetadataSchema,
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

export const PragmaAutomationPromptSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => pragmaUnicodeLength(value) <= PRAGMA_TEXT_LIMITS.automation.prompt, {
    message: `Must contain at most ${PRAGMA_TEXT_LIMITS.automation.prompt} characters.`,
  });

export const PragmaAutomationResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Automation"),
    metadata: PragmaAutomationMetadataSchema,
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
                  value: PragmaAutomationPromptSchema,
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
    metadata: PragmaCapabilityMetadataSchema,
    spec: PragmaAdapterResourceSpecSchema,
  })
  .strict();

export const PragmaContextStoreResourceSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("ContextStore"),
    metadata: PragmaContextStoreMetadataSchema,
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

export const PragmaResourceSchema = z.union([
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  PragmaFlowResourceSchema,
  PragmaAutomationResourceSchema,
  PragmaCapabilityResourceSchema,
  PragmaContextStoreResourceSchema,
  PragmaRuntimeProfileResourceSchema,
  PragmaEvaluationResourceSchema,
]);

const PragmaForwardCompatibleExpertResourceSchema = PragmaExpertResourceSchema.safeExtend({
  metadata: PragmaExpertMetadataSchema.passthrough(),
  spec: PragmaExpertResourceSchema.shape.spec.passthrough(),
}).passthrough();

const PragmaForwardCompatibleExpertTeamResourceSchema = PragmaExpertTeamResourceSchema.safeExtend({
  metadata: PragmaExpertTeamMetadataSchema.passthrough(),
  spec: PragmaExpertTeamResourceSchema.shape.spec
    .extend({
      delegation: PragmaExpertTeamResourceSchema.shape.spec.shape.delegation.passthrough(),
    })
    .passthrough(),
}).passthrough();

const PragmaForwardCompatibleFlowResourceSchema = PragmaFlowResourceSchema.safeExtend({
  metadata: PragmaFlowMetadataSchema.passthrough(),
  spec: PragmaFlowResourceSchema.shape.spec.passthrough(),
}).passthrough();

const PragmaForwardCompatibleAutomationResourceSchema = PragmaAutomationResourceSchema.safeExtend({
  metadata: PragmaAutomationMetadataSchema.passthrough(),
  spec: PragmaAutomationResourceSchema.shape.spec.passthrough(),
}).passthrough();

const PragmaForwardCompatibleCapabilityResourceSchema = PragmaCapabilityResourceSchema.safeExtend({
  metadata: PragmaCapabilityMetadataSchema.passthrough(),
  spec: PragmaCapabilityResourceSchema.shape.spec.passthrough(),
}).passthrough();

const PragmaForwardCompatibleContextStoreResourceSchema =
  PragmaContextStoreResourceSchema.safeExtend({
    metadata: PragmaContextStoreMetadataSchema.passthrough(),
    spec: PragmaContextStoreResourceSchema.shape.spec.passthrough(),
  }).passthrough();

const PragmaForwardCompatibleRuntimeProfileResourceSchema =
  PragmaRuntimeProfileResourceSchema.safeExtend({
    metadata: PragmaMetadataSchema.passthrough(),
    spec: PragmaRuntimeProfileResourceSchema.shape.spec.passthrough(),
  }).passthrough();

const PragmaForwardCompatibleFlowRunDryEvaluationResourceSchema =
  PragmaFlowRunDryEvaluationResourceSchema.safeExtend({
    metadata: PragmaEvaluationMetadataSchema.passthrough(),
    spec: PragmaFlowRunDryEvaluationSpecSchema.passthrough(),
  }).passthrough();

const PragmaForwardCompatibleAgentJudgeEvaluationResourceSchema =
  PragmaAgentJudgeEvaluationResourceSchema.safeExtend({
    metadata: PragmaEvaluationMetadataSchema.passthrough(),
    spec: PragmaAgentJudgeEvaluationSpecSchema.passthrough(),
  }).passthrough();

/**
 * Persistence boundary for pragma/v5 resources. Known fields remain fully validated while
 * additive fields at the resource, metadata, spec, and Team delegation extension points are
 * retained for same-version forward compatibility.
 */
export const PragmaForwardCompatibleResourceSchema: z.ZodType<PragmaResource> = z.union([
  PragmaForwardCompatibleExpertResourceSchema,
  PragmaForwardCompatibleExpertTeamResourceSchema,
  PragmaForwardCompatibleFlowResourceSchema,
  PragmaForwardCompatibleAutomationResourceSchema,
  PragmaForwardCompatibleCapabilityResourceSchema,
  PragmaForwardCompatibleContextStoreResourceSchema,
  PragmaForwardCompatibleRuntimeProfileResourceSchema,
  PragmaForwardCompatibleFlowRunDryEvaluationResourceSchema,
  PragmaForwardCompatibleAgentJudgeEvaluationResourceSchema,
]);

export const PragmaBundleSchema = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaResourceSchema).default([]),
  })
  .strict();

export const PragmaForwardCompatibleBundleSchema: z.ZodType<PragmaBundle> = z
  .object({
    apiVersion: PragmaApiVersionSchema,
    kind: z.literal("Bundle"),
    imports: z.array(z.string().trim().min(1)).default([]),
    resources: z.array(PragmaForwardCompatibleResourceSchema).default([]),
  })
  .passthrough();

export interface PragmaUnknownFieldIssue {
  readonly key: string;
  readonly path: readonly (string | number)[];
}

export function inspectPragmaUnknownFields(
  value: unknown,
  kind: "resource" | "bundle",
): readonly PragmaUnknownFieldIssue[] {
  const parsed = (
    kind === "bundle" ? PragmaBundleSchema : strictResourceSchemaFor(value)
  ).safeParse(value);
  if (parsed.success) return [];
  const output: PragmaUnknownFieldIssue[] = [];
  collectUnknownFieldIssues(parsed.error.issues, output);
  return output;
}

function strictResourceSchemaFor(value: unknown): z.ZodType {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return PragmaResourceSchema;
  }
  const record = value as Record<string, unknown>;
  switch (record["kind"]) {
    case "Expert":
      return PragmaExpertResourceSchema;
    case "ExpertTeam":
      return PragmaExpertTeamResourceSchema;
    case "Flow":
      return PragmaFlowResourceSchema;
    case "Automation":
      return PragmaAutomationResourceSchema;
    case "Capability":
      return PragmaCapabilityResourceSchema;
    case "ContextStore":
      return PragmaContextStoreResourceSchema;
    case "RuntimeProfile":
      return PragmaRuntimeProfileResourceSchema;
    case "Evaluation": {
      const spec = record["spec"];
      const method =
        typeof spec === "object" && spec !== null && !Array.isArray(spec)
          ? (spec as Record<string, unknown>)["method"]
          : undefined;
      const type =
        typeof method === "object" && method !== null && !Array.isArray(method)
          ? (method as Record<string, unknown>)["type"]
          : undefined;
      return type === "flow-run-dry"
        ? PragmaFlowRunDryEvaluationResourceSchema
        : type === "agent-judge"
          ? PragmaAgentJudgeEvaluationResourceSchema
          : PragmaEvaluationResourceSchema;
    }
    default:
      return PragmaResourceSchema;
  }
}

function collectUnknownFieldIssues(
  issues: readonly unknown[],
  output: PragmaUnknownFieldIssue[],
): void {
  for (const issue of issues) {
    if (typeof issue !== "object" || issue === null) continue;
    const record = issue as Record<string, unknown>;
    const path = Array.isArray(record["path"])
      ? record["path"].filter(
          (segment): segment is string | number =>
            typeof segment === "string" || typeof segment === "number",
        )
      : [];
    if (record["code"] === "unrecognized_keys" && Array.isArray(record["keys"])) {
      for (const key of record["keys"]) {
        if (typeof key === "string") output.push({ key, path: [...path, key] });
      }
    }
    const nested = record["errors"];
    if (!Array.isArray(nested)) continue;
    for (const branch of nested) {
      if (Array.isArray(branch)) collectUnknownFieldIssues(branch, output);
    }
  }
}

/**
 * Applies a current-client resource update without discarding additive fields that the client
 * does not understand. Plain objects merge recursively; arrays and scalar values are replaced.
 */
export function mergePragmaResourcePreservingUnknownFields(
  original: PragmaResource,
  updated: PragmaResource,
): PragmaResource {
  return PragmaForwardCompatibleResourceSchema.parse(mergeCompatibleValue(original, updated));
}

function mergeCompatibleValue(original: unknown, updated: unknown): unknown {
  if (!isPlainRecord(original) || !isPlainRecord(updated)) return structuredClone(updated);
  const merged: Record<string, unknown> = structuredClone(original);
  for (const [key, value] of Object.entries(updated)) {
    merged[key] = mergeCompatibleValue(original[key], value);
  }
  return merged;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

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
    resourceRef: PragmaSemanticResourceRefSchema.optional(),
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
            expertRef: PragmaExpertRefSchema,
            ref: versionedExtensionRefSchema(["plugin"], "plugin:example@1.0.0"),
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
export type PragmaExpertTeamContextVisibility = z.infer<
  typeof PragmaExpertTeamContextVisibilitySchema
>;
export type PragmaExpertTeamResource = z.infer<typeof PragmaExpertTeamResourceSchema>;
export type PragmaFlowResource = z.infer<typeof PragmaFlowResourceSchema>;
export type PragmaAutomationResource = z.infer<typeof PragmaAutomationResourceSchema>;
export type PragmaScheduleTrigger = z.infer<typeof PragmaScheduleTriggerSchema>;
export type PragmaScheduleAutomationConfig = z.infer<typeof PragmaScheduleAutomationConfigSchema>;
export type PragmaCapabilityResource = z.infer<typeof PragmaCapabilityResourceSchema>;
export type PragmaContextStoreResource = z.infer<typeof PragmaContextStoreResourceSchema>;
export type PragmaRuntimeProfileResource = z.infer<typeof PragmaRuntimeProfileResourceSchema>;
export type PragmaEvaluationResource = z.infer<typeof PragmaEvaluationResourceSchema>;
export type PragmaFlowRunDryEvaluationResource = z.infer<
  typeof PragmaFlowRunDryEvaluationResourceSchema
>;
export type PragmaAgentJudgeEvaluationResource = z.infer<
  typeof PragmaAgentJudgeEvaluationResourceSchema
>;
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
export {
  type PragmaFlowRunDryCase,
  type PragmaFlowRunDryMockOutcome,
  type PragmaFlowRunDrySuite,
  PragmaFlowRunDryCaseSchema,
  PragmaFlowRunDryMockOutcomeSchema,
  PragmaFlowRunDryMockSequenceSchema,
  PragmaFlowRunDrySuiteSchema,
} from "@pragma/evaluation/ast";
export type PragmaRuntimeProfileConfig = z.infer<typeof PragmaRuntimeProfileConfigSchema>;
export type PragmaHumanRequest = z.infer<typeof PragmaHumanRequestSchema>;
