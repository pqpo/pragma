import type { PragmaExpertResource } from "@pragma/interpreter/ast";
import {
  BUILT_IN_PRAGMA_REF,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
} from "@pragma/built-in-agents";
import { z } from "zod";

import { UpdateBuiltInExpertDefinitionSchema } from "../../../shared/contracts/index.ts";

export const SYSTEM_EXPERT_CONFIG_SCHEMA_VERSION = 7;
const LEGACY_BUILT_IN_PRAGMA_REF = "expert:pragma@1.0.0";

const LegacyUpdateBuiltInExpertDefinitionSchema = UpdateBuiltInExpertDefinitionSchema.omit({
  resourceTools: true,
});

export const SystemExpertCustomizationSchema = UpdateBuiltInExpertDefinitionSchema.extend({
  ref: z.enum([BUILT_IN_PRAGMA_REF, STORE_REVISION_EXPERT_REF, SKILL_REVISION_EXPERT_REF]),
  revision: z.number().int().min(2),
  updatedAt: z.string().datetime(),
});

export const SystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(SYSTEM_EXPERT_CONFIG_SCHEMA_VERSION),
  customizations: z.array(SystemExpertCustomizationSchema).max(100),
});

const V3SystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(3),
  customizations: z
    .array(
      LegacyUpdateBuiltInExpertDefinitionSchema.extend({
        ref: z.literal(LEGACY_BUILT_IN_PRAGMA_REF),
        revision: z.number().int().min(2),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(100),
});

const V4SystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(4),
  customizations: z
    .array(
      LegacyUpdateBuiltInExpertDefinitionSchema.extend({
        ref: z.literal(BUILT_IN_PRAGMA_REF),
        revision: z.number().int().min(2),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(100),
});

const V5SystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(5),
  customizations: z
    .array(
      LegacyUpdateBuiltInExpertDefinitionSchema.extend({
        ref: z.enum([BUILT_IN_PRAGMA_REF, STORE_REVISION_EXPERT_REF]),
        revision: z.number().int().min(2),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(100),
});

const V6SystemExpertCustomizationConfigSchema = z.object({
  schemaVersion: z.literal(6),
  customizations: z
    .array(
      LegacyUpdateBuiltInExpertDefinitionSchema.extend({
        ref: z.enum([BUILT_IN_PRAGMA_REF, STORE_REVISION_EXPERT_REF, SKILL_REVISION_EXPERT_REF]),
        revision: z.number().int().min(2),
        updatedAt: z.string().datetime(),
      }),
    )
    .max(100),
});

export type SystemExpertCustomization = z.infer<typeof SystemExpertCustomizationSchema>;
export type SystemExpertCustomizationConfig = z.infer<typeof SystemExpertCustomizationConfigSchema>;
type V3SystemExpertCustomizationConfig = z.infer<typeof V3SystemExpertCustomizationConfigSchema>;
type V4SystemExpertCustomizationConfig = z.infer<typeof V4SystemExpertCustomizationConfigSchema>;
type V5SystemExpertCustomizationConfig = z.infer<typeof V5SystemExpertCustomizationConfigSchema>;
type V6SystemExpertCustomizationConfig = z.infer<typeof V6SystemExpertCustomizationConfigSchema>;

function migrateV3ToV4(
  source: V3SystemExpertCustomizationConfig,
): V4SystemExpertCustomizationConfig {
  return V4SystemExpertCustomizationConfigSchema.parse({
    schemaVersion: 4,
    customizations: source.customizations.map((customization) => ({
      ...customization,
      ref: BUILT_IN_PRAGMA_REF,
    })),
  });
}

function migrateV4ToV5(
  source: V4SystemExpertCustomizationConfig,
): V5SystemExpertCustomizationConfig {
  return V5SystemExpertCustomizationConfigSchema.parse({ ...source, schemaVersion: 5 });
}

function migrateV5ToV6(
  source: V5SystemExpertCustomizationConfig,
): V6SystemExpertCustomizationConfig {
  return V6SystemExpertCustomizationConfigSchema.parse({ ...source, schemaVersion: 6 });
}

function migrateV6ToV7(
  source: V6SystemExpertCustomizationConfig,
  defaultPragmaTools: PragmaExpertResource["spec"]["tools"],
): SystemExpertCustomizationConfig {
  return SystemExpertCustomizationConfigSchema.parse({
    schemaVersion: SYSTEM_EXPERT_CONFIG_SCHEMA_VERSION,
    customizations: source.customizations.map((customization) => ({
      ...customization,
      resourceTools: customization.ref === BUILT_IN_PRAGMA_REF ? defaultPragmaTools : [],
    })),
  });
}

export function migrateSystemExpertCustomizationConfig(
  source: unknown,
  defaultPragmaTools: PragmaExpertResource["spec"]["tools"],
): { readonly sourceVersion: 3 | 4 | 5 | 6; readonly config: SystemExpertCustomizationConfig } {
  const parsedV6 = V6SystemExpertCustomizationConfigSchema.safeParse(source);
  if (parsedV6.success) {
    return { sourceVersion: 6, config: migrateV6ToV7(parsedV6.data, defaultPragmaTools) };
  }
  const parsedV5 = V5SystemExpertCustomizationConfigSchema.safeParse(source);
  if (parsedV5.success) {
    return {
      sourceVersion: 5,
      config: migrateV6ToV7(migrateV5ToV6(parsedV5.data), defaultPragmaTools),
    };
  }
  const parsedV4 = V4SystemExpertCustomizationConfigSchema.safeParse(source);
  if (parsedV4.success) {
    return {
      sourceVersion: 4,
      config: migrateV6ToV7(migrateV5ToV6(migrateV4ToV5(parsedV4.data)), defaultPragmaTools),
    };
  }
  const parsedV3 = V3SystemExpertCustomizationConfigSchema.parse(source);
  return {
    sourceVersion: 3,
    config: migrateV6ToV7(
      migrateV5ToV6(migrateV4ToV5(migrateV3ToV4(parsedV3))),
      defaultPragmaTools,
    ),
  };
}
