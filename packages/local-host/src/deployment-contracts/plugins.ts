export {
  DesktopPluginRefSchema,
  DesktopPluginConfigurationPropertySchema,
  DesktopPluginManifestSchema,
  DesktopPluginSchema,
} from "@pragma/shared";
import { DesktopPluginRefSchema, DesktopPluginManifestSchema } from "@pragma/shared";
import { PragmaBindingRefSchema } from "@pragma/interpreter/ast";
import { z } from "zod";
export const ExpertToolApprovalModeSchema = z.enum(["none", "ask", "required"]);
export const InspectPluginZipSchema = z.object({ sourcePath: z.string().trim().min(1).max(2000) });
export const PluginZipInspectionSchema = z
  .object({
    sourcePath: z.string().trim().min(1).max(2000),
    contentHash: z.string().regex(/^[a-f0-9]{64}$/),
    manifest: DesktopPluginManifestSchema,
    fileCount: z.number().int().positive(),
    unpackedBytes: z.number().int().positive(),
  })
  .strict();
export const ImportPluginZipSchema = z.object({
  sourcePath: z.string().trim().min(1).max(2000),
  expectedHash: z.string().regex(/^[a-f0-9]{64}$/),
});
export const UpdatePluginDefaultsSchema = z.object({
  ref: DesktopPluginRefSchema,
  config: z.record(z.string(), z.unknown()),
  secrets: z.record(z.string(), z.string().nullable()),
});
export const SetPluginSecretsSchema = z.object({
  secrets: z.record(PragmaBindingRefSchema, z.string().nullable()),
});
export const PluginActionSchema = z.object({ ref: DesktopPluginRefSchema });
export const ExpertPluginReferenceSchema = z
  .object({
    ref: DesktopPluginRefSchema,
    config: z.record(z.string(), z.unknown()).optional(),
    secretBindings: z.record(z.string(), PragmaBindingRefSchema).optional(),
  })
  .strict();
