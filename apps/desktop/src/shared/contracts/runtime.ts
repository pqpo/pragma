import { z } from "zod";

export {
  RuntimeProcessEnvironmentPolicySchema,
  RuntimeProcessEnvironmentSettingsSchema,
  UpdateRuntimeProcessEnvironmentPolicySchema,
} from "@pragma/shared";

export const DesktopAppInfoSchema = z.object({
  name: z.literal("Pragma"),
  version: z.string(),
  os: z.enum(["macos", "windows", "linux", "unknown"]),
});

export const RuntimeGatewayConfigSchema = z.object({
  schemaVersion: z.literal(1),
  endpoint: z.string(),
  transport: z.literal("websocket"),
});

export const LocalRuntimeCapabilitySchema = z.object({
  id: z.enum(["codex", "claude-code", "self-hosted-agent"]),
  label: z.string(),
  status: z.enum(["available", "not_configured"]),
});

export * from "@pragma/local-host/deployment-contracts";

export const DesktopRuntimeProcessEnvironmentStatusSchema = z
  .object({
    generation: z.number().int().positive(),
    status: z.enum(["ready", "degraded"]),
    source: z.enum(["login-shell", "fallback", "original"]),
    capturedAt: z.number().int().nonnegative(),
    failureKind: z
      .enum([
        "invalid-output",
        "output-limit",
        "spawn-failed",
        "timeout",
        "unsupported-shell",
        "unexpected-error",
      ])
      .optional(),
  })
  .strict();

export const DesktopBridgeStartupSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ready") }).strict(),
  z
    .object({
      status: z.literal("failed"),
      code: z.literal("DESKTOP_MAIN_INITIALIZATION_FAILED"),
    })
    .strict(),
]);

export const DesktopBridgeSnapshotSchema = z.object({
  app: DesktopAppInfoSchema,
  startup: DesktopBridgeStartupSchema,
  interpreter: z
    .object({
      writeVersion: z.string().min(1),
      directReadVersions: z.array(z.string().min(1)).min(1),
      upgradeFromVersions: z.array(z.string().min(1)),
    })
    .strict()
    .optional(),
  gateway: RuntimeGatewayConfigSchema,
  device: z.object({
    status: z.literal("offline"),
    label: z.string(),
  }),
  workspace: z.object({
    path: z.string().nullable(),
    status: z.enum(["unset", "ready"]),
  }),
  capabilities: z.array(LocalRuntimeCapabilitySchema),
});
