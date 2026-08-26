import {
  PRAGMA_COMPILER_WRITE_VERSION,
  isPragmaCompilerVersionDirectlyReadable,
  isPragmaCompilerVersionUpgradeable,
} from "../ast/compiler-compatibility.ts";
import {
  PragmaForwardCompatibleBundleSchema,
  PragmaForwardCompatibleResourceSchema,
  PragmaLockSchema,
  canonicalPragmaResourceRef,
  type PragmaResource,
} from "../ast/index.ts";
import { parsePragmaYaml } from "../compiler/pragma-project.ts";
import { sha256, stableStringify } from "../compiler/compiler-hash.ts";
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

export const PRAGMA_COMPILER_MIGRATION_CHAIN_VERSION = "pragma.compiler-migrations/v7";

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
                  : migratePragmaCompilerV8Project(input);
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

function parseCurrentProject(
  files: ReadonlyMap<string, string>,
  revisionCompilerVersion: PragmaCompilerVersion,
): {
  readonly resources: readonly PragmaResource[];
  readonly artifacts: ReadonlyMap<string, string>;
} {
  const lockSource = files.get("pragma.lock.yaml");
  if (lockSource === undefined) {
    throw new PragmaCompilerMigrationError(
      "lock_missing",
      "Current compiler project revision is missing pragma.lock.yaml.",
    );
  }
  let lock;
  try {
    lock = PragmaLockSchema.parse(parsePragmaYaml(lockSource));
  } catch (error) {
    throw new PragmaCompilerMigrationError(
      "invalid_legacy_project",
      "Current compiler project revision has an invalid pragma.lock.yaml.",
      { cause: error },
    );
  }
  if (lock.compilerVersion !== revisionCompilerVersion) {
    throw new PragmaCompilerMigrationError(
      "compiler_metadata_mismatch",
      `Project revision metadata declares ${revisionCompilerVersion}, but pragma.lock.yaml declares ${lock.compilerVersion}.`,
    );
  }

  const indexed: { readonly resource: PragmaResource; readonly source: string }[] = [];
  const managed = new Set(["pragma.yaml", "pragma.lock.yaml"]);
  for (const [source, contents] of files) {
    if (source !== "pragma.yaml" && !source.endsWith(".pragma.yaml")) continue;
    try {
      const value = parsePragmaYaml(contents);
      if (isRecord(value) && value["kind"] === "Bundle") {
        const bundle = PragmaForwardCompatibleBundleSchema.parse(value);
        for (const resource of bundle.resources) {
          indexed.push({ resource, source });
        }
        managed.add(source);
        continue;
      }
      if (isRecord(value) && typeof value["kind"] === "string" && value["kind"] !== "Lock") {
        indexed.push({ resource: PragmaForwardCompatibleResourceSchema.parse(value), source });
        managed.add(source);
      }
    } catch (error) {
      throw new PragmaCompilerMigrationError(
        "invalid_legacy_project",
        `Current compiler project source is invalid: ${source}.`,
        { cause: error },
      );
    }
  }
  const expectedResources = indexed
    .map(({ resource, source }) => ({
      ref: canonicalPragmaResourceRef(resource),
      contentHash: sha256(stableStringify(resource)),
      source,
    }))
    .toSorted((left, right) => left.ref.localeCompare(right.ref));
  const actualByRef = new Map(lock.resources.map((resource) => [resource.ref, resource]));
  const mismatches = expectedResources
    .filter((expected) => {
      const actual = actualByRef.get(expected.ref);
      return (
        actual === undefined ||
        actual.contentHash !== expected.contentHash ||
        actual.source !== expected.source
      );
    })
    .map((resource) => resource.ref);
  if (actualByRef.size !== expectedResources.length) mismatches.push("resource set");
  const expectedProjectFingerprint = sha256(
    stableStringify({
      resources: expectedResources.map(({ ref, contentHash }) => ({ ref, contentHash })),
      artifacts: [...lock.artifacts].toSorted((left, right) =>
        left.source.localeCompare(right.source),
      ),
    }),
  );
  if (mismatches.length > 0 || expectedProjectFingerprint !== lock.projectFingerprint) {
    throw new PragmaCompilerMigrationError(
      "lock_mismatch",
      `Current compiler project revision does not match its lock: ${mismatches.join(", ") || "project fingerprint"}.`,
    );
  }
  return {
    resources: indexed.map(({ resource }) => resource),
    artifacts: new Map([...files].filter(([path]) => !managed.has(path))),
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
