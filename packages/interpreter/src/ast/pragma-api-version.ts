import { z } from "zod";

export const PRAGMA_DSL_WRITE_API_VERSION = "pragma/v5" as const;

export const PRAGMA_DSL_DIRECT_READ_API_VERSIONS = [PRAGMA_DSL_WRITE_API_VERSION] as const;

export const PRAGMA_DSL_UPGRADE_FROM_API_VERSIONS = [
  "pragma/v2",
  "pragma/v3",
  "pragma/v4",
] as const;

export const PragmaApiVersionSchema = z.literal(PRAGMA_DSL_WRITE_API_VERSION);

export function isPragmaDslApiVersionDirectlyReadable(version: string): boolean {
  return (PRAGMA_DSL_DIRECT_READ_API_VERSIONS as readonly string[]).includes(version);
}

export function isPragmaDslApiVersionUpgradeable(version: string): boolean {
  return (PRAGMA_DSL_UPGRADE_FROM_API_VERSIONS as readonly string[]).includes(version);
}
