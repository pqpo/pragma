import type { PragmaResource } from "../ast/pragma-dsl.schema.ts";

export type PragmaCompilerVersion = `pragma.dsl/v${number}`;

export interface PragmaCompilerProjectMigrationResult {
  readonly sourceCompilerVersion: PragmaCompilerVersion;
  readonly targetCompilerVersion: PragmaCompilerVersion;
  readonly migrated: boolean;
  readonly resources: readonly PragmaResource[];
  readonly artifacts: ReadonlyMap<string, string>;
}

export type PragmaCompilerMigrationErrorCode =
  | "compiler_metadata_mismatch"
  | "future_compiler_version"
  | "invalid_legacy_project"
  | "lock_mismatch"
  | "lock_missing"
  | "missing_migration_step";

export class PragmaCompilerMigrationError extends Error {
  constructor(
    readonly code: PragmaCompilerMigrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PragmaCompilerMigrationError";
  }
}
