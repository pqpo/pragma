import {
  PRAGMA_COMPILER_WRITE_VERSION,
  isPragmaCompilerVersionDirectlyReadable,
  isPragmaCompilerVersionUpgradeable,
} from "../ast/compiler-compatibility.ts";
import { parseCurrentProject } from "./validate-project.ts";
import { migratePragmaCompilerV11Project } from "./steps/v11-to-v12.ts";
import { migratePragmaCompilerV2Project } from "./steps/v2-to-v3.ts";
import { migratePragmaCompilerV3Project } from "./steps/v3-to-v4.ts";
import { migratePragmaCompilerV4Project } from "./steps/v4-to-v5.ts";
import { migratePragmaCompilerV5Project } from "./steps/v5-to-v6.ts";
import { migratePragmaCompilerV6Project } from "./steps/v6-to-v7.ts";
import { migratePragmaCompilerV7Project } from "./steps/v7-to-v8.ts";
import { migratePragmaCompilerV8Project } from "./steps/v8-to-v9.ts";
import {
  PragmaCompilerMigrationError,
  type PragmaCompilerProjectMigrationResult,
  type PragmaCompilerVersion,
} from "./types.ts";

export {
  PragmaCompilerMigrationError,
  type PragmaCompilerMigrationErrorCode,
  type PragmaCompilerProjectMigrationResult,
  type PragmaCompilerVersion,
} from "./types.ts";

import { migratePragmaCompilerV9Project } from "./steps/v9-to-v10.ts";

export const PRAGMA_COMPILER_MIGRATION_CHAIN_VERSION = "pragma.compiler-migrations/v10";

export function migratePragmaCompilerProjectToCurrent(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly revisionCompilerVersion: string;
}): PragmaCompilerProjectMigrationResult {
  const sourceCompilerVersion = parseCompilerVersion(input.revisionCompilerVersion);
  if (isPragmaCompilerVersionUpgradeable(sourceCompilerVersion)) {
    const migrated =
      sourceCompilerVersion === "pragma.dsl/v2"
        ? migratePragmaCompilerV2Project(input)
        : sourceCompilerVersion === "pragma.dsl/v3"
          ? migratePragmaCompilerV3Project(input)
          : sourceCompilerVersion === "pragma.dsl/v4"
            ? migratePragmaCompilerV4Project(input)
            : sourceCompilerVersion === "pragma.dsl/v5"
              ? migratePragmaCompilerV5Project(input)
              : sourceCompilerVersion === "pragma.dsl/v6"
                ? migratePragmaCompilerV6Project(input)
                : sourceCompilerVersion === "pragma.dsl/v7"
                  ? migratePragmaCompilerV7Project(input)
                  : sourceCompilerVersion === "pragma.dsl/v8"
                    ? migratePragmaCompilerV8Project(input)
                    : sourceCompilerVersion === "pragma.dsl/v9"
                      ? migratePragmaCompilerV9Project(input)
                      : sourceCompilerVersion === "pragma.dsl/v10"
                        ? parseCurrentProject(input.files, sourceCompilerVersion)
                        : migratePragmaCompilerV11Project(input);
    return {
      sourceCompilerVersion,
      targetCompilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
      migrated: true,
      ...migrated,
    };
  }
  if (!isPragmaCompilerVersionDirectlyReadable(sourceCompilerVersion)) {
    const source = compilerVersionNumber(sourceCompilerVersion);
    const target = compilerVersionNumber(PRAGMA_COMPILER_WRITE_VERSION);
    throw new PragmaCompilerMigrationError(
      source > target ? "future_compiler_version" : "missing_migration_step",
      `Pragma compiler ${sourceCompilerVersion} cannot be upgraded to ${PRAGMA_COMPILER_WRITE_VERSION}.`,
    );
  }
  return {
    sourceCompilerVersion,
    targetCompilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
    migrated: false,
    ...parseCurrentProject(input.files, sourceCompilerVersion),
  };
}

function parseCompilerVersion(value: string): PragmaCompilerVersion {
  if (!/^pragma\.dsl\/v[1-9][0-9]*$/u.test(value)) {
    throw new PragmaCompilerMigrationError(
      "missing_migration_step",
      `Unsupported Pragma compiler version: ${value}.`,
    );
  }
  return value as PragmaCompilerVersion;
}

function compilerVersionNumber(value: PragmaCompilerVersion): number {
  return Number(value.slice("pragma.dsl/v".length));
}
