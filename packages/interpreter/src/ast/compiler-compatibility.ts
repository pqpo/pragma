export const PRAGMA_COMPILER_WRITE_VERSION = "pragma.dsl/v3";

export const PRAGMA_COMPILER_READ_VERSIONS = [
  "pragma.dsl/v2",
  PRAGMA_COMPILER_WRITE_VERSION,
] as const;

export function isPragmaCompilerVersionReadable(version: string): boolean {
  return (PRAGMA_COMPILER_READ_VERSIONS as readonly string[]).includes(version);
}
