export const PRAGMA_COMPILER_WRITE_VERSION = "pragma.dsl/v4";

export const PRAGMA_COMPILER_DIRECT_READ_VERSIONS = [PRAGMA_COMPILER_WRITE_VERSION] as const;

export const PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS = ["pragma.dsl/v2", "pragma.dsl/v3"] as const;

export function isPragmaCompilerVersionDirectlyReadable(version: string): boolean {
  return (PRAGMA_COMPILER_DIRECT_READ_VERSIONS as readonly string[]).includes(version);
}

export function isPragmaCompilerVersionUpgradeable(version: string): boolean {
  return (PRAGMA_COMPILER_UPGRADE_FROM_VERSIONS as readonly string[]).includes(version);
}
