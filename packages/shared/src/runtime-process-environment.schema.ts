import { z } from "zod";

export const RuntimeProcessEnvironmentVariableNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const RuntimeProcessEnvironmentPolicySchema = z
  .object({
    mode: z.enum(["filtered", "inherit-all"]).default("filtered"),
    allowlist: z.array(RuntimeProcessEnvironmentVariableNameSchema).max(256).default([]),
    blocklist: z.array(RuntimeProcessEnvironmentVariableNameSchema).max(256).default([]),
  })
  .strict();

export const RuntimeProcessEnvironmentSettingsSchema = z
  .object({
    schemaVersion: z.literal("pragma.runtime-process-environment-settings/v1"),
    revision: z.number().int().nonnegative(),
    policy: RuntimeProcessEnvironmentPolicySchema,
  })
  .strict();

export const UpdateRuntimeProcessEnvironmentPolicySchema = z
  .object({
    expectedRevision: z.number().int().nonnegative(),
    policy: RuntimeProcessEnvironmentPolicySchema,
  })
  .strict();

export type RuntimeProcessEnvironmentVariableName = z.infer<
  typeof RuntimeProcessEnvironmentVariableNameSchema
>;
export type RuntimeProcessEnvironmentPolicy = z.infer<typeof RuntimeProcessEnvironmentPolicySchema>;
export type RuntimeProcessEnvironmentSettings = z.infer<
  typeof RuntimeProcessEnvironmentSettingsSchema
>;
export type UpdateRuntimeProcessEnvironmentPolicy = z.infer<
  typeof UpdateRuntimeProcessEnvironmentPolicySchema
>;

export const DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY: RuntimeProcessEnvironmentPolicy = {
  mode: "filtered",
  allowlist: [],
  blocklist: [],
};

export const DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_SETTINGS: RuntimeProcessEnvironmentSettings = {
  schemaVersion: "pragma.runtime-process-environment-settings/v1",
  revision: 0,
  policy: DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
};
