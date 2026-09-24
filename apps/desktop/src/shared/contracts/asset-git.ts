import { z } from "zod";

import { CapabilityIdSchema } from "./capabilities.ts";
import { ContextStoreIdSchema } from "./context-stores.ts";
import {
  DesktopBundleRegistryBranchSchema,
  DesktopBundleRegistryRemoteSchema,
} from "./bundle-registry.ts";

export const AssetGitKindSchema = z.enum(["knowledge", "skill"]);
export const AssetGitTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("knowledge"), id: ContextStoreIdSchema }).strict(),
  z.object({ kind: z.literal("skill"), id: CapabilityIdSchema }).strict(),
]);
export const AssetGitSourceSchema = z
  .object({
    remote: DesktopBundleRegistryRemoteSchema,
    branch: DesktopBundleRegistryBranchSchema.optional(),
  })
  .strict();
export const AssetGitBindSchema = z
  .object({ target: AssetGitTargetSchema, source: AssetGitSourceSchema })
  .strict();
export const AssetGitImportSchema = z
  .object({ kind: AssetGitKindSchema, source: AssetGitSourceSchema })
  .strict();
export const AssetGitStatusSchema = z
  .object({
    target: AssetGitTargetSchema,
    source: AssetGitSourceSchema.optional(),
    status: z.enum(["unbound", "pending", "syncing", "synced", "conflict", "error"]),
    syncedAt: z.string().datetime().optional(),
    conflictPaths: z.array(z.string()).optional(),
    error: z.string().optional(),
  })
  .strict();

export type AssetGitTarget = z.infer<typeof AssetGitTargetSchema>;
export type AssetGitSource = z.infer<typeof AssetGitSourceSchema>;
export type AssetGitStatus = z.infer<typeof AssetGitStatusSchema>;
