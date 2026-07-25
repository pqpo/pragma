import type { PragmaResource } from "../ast/pragma-dsl.schema.ts";

export type PragmaDslApiVersion = `pragma/v${number}`;

export interface PragmaResourceIdentityMigration {
  readonly kind: PragmaResource["kind"];
  readonly sourceId: string;
  readonly targetId: string;
}

export interface PragmaDslProjectMigrationResult {
  readonly sourceApiVersion: PragmaDslApiVersion;
  readonly targetApiVersion: PragmaDslApiVersion;
  readonly migrated: boolean;
  readonly resources: readonly PragmaResource[];
  readonly artifacts: ReadonlyMap<string, string>;
  readonly identityMigrations: readonly PragmaResourceIdentityMigration[];
}

export type PragmaDslMigrationErrorCode =
  | "identity_conflict"
  | "invalid_legacy_project"
  | "invalid_migrated_project"
  | "missing_migration_step"
  | "mixed_api_versions"
  | "name_conflict"
  | "unresolved_reference"
  | "unsupported_api_version";

export class PragmaDslMigrationError extends Error {
  constructor(
    readonly code: PragmaDslMigrationErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "PragmaDslMigrationError";
  }
}

export interface PragmaDslMigrationProject {
  readonly projectId: string;
  readonly resources: readonly unknown[];
  readonly artifacts: ReadonlyMap<string, string>;
  readonly identityMigrations: readonly PragmaResourceIdentityMigration[];
}

export interface PragmaDslMigrationStep {
  readonly fromApiVersion: PragmaDslApiVersion;
  readonly toApiVersion: PragmaDslApiVersion;
  readonly migrate: (project: PragmaDslMigrationProject) => PragmaDslMigrationProject;
}
