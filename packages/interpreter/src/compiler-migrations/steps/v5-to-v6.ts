import { canonicalPragmaResourceRef, type PragmaResource } from "../../ast/index.ts";
import { parsePragmaYaml } from "../../compiler/pragma-project.ts";
import { sha256, stableStringify } from "../../compiler/compiler-hash.ts";
import {
  PragmaV3BundleSchema,
  PragmaV3LockSchema,
  PragmaV3SemanticResourceSchema,
} from "../../migrations/schemas/v3.ts";
import { migratePragmaV3ResourceToCurrent } from "../../migrations/steps/v3-to-v4.ts";
import { PragmaCompilerMigrationError } from "../types.ts";

interface ParsedCompilerV5Resource {
  readonly source: string;
  readonly historical: unknown;
  readonly current: PragmaResource;
}

/** Upgrades compiler v5's pragma/v3 sources to pragma/v4 avatar metadata. */
export function migratePragmaCompilerV5Project(input: {
  readonly files: ReadonlyMap<string, string>;
  readonly revisionCompilerVersion: string;
}): {
  readonly resources: readonly PragmaResource[];
  readonly artifacts: ReadonlyMap<string, string>;
} {
  const lockSource = input.files.get("pragma.lock.yaml");
  if (lockSource === undefined) {
    throw new PragmaCompilerMigrationError(
      "lock_missing",
      "Compiler v5 project revision is missing pragma.lock.yaml.",
    );
  }
  let lock;
  try {
    lock = PragmaV3LockSchema.parse(parsePragmaYaml(lockSource));
  } catch (error) {
    throw new PragmaCompilerMigrationError(
      "invalid_legacy_project",
      "Compiler v5 project revision has an invalid pragma.lock.yaml.",
      { cause: error },
    );
  }
  if (
    input.revisionCompilerVersion !== "pragma.dsl/v5" ||
    lock.compilerVersion !== input.revisionCompilerVersion
  ) {
    throw new PragmaCompilerMigrationError(
      "compiler_metadata_mismatch",
      `Project revision metadata declares ${input.revisionCompilerVersion}, but pragma.lock.yaml declares ${lock.compilerVersion}.`,
    );
  }

  const parsed = extractResources(input.files);
  const actual = parsed
    .map(({ source, historical, current }) => ({
      ref: canonicalPragmaResourceRef(current),
      source,
      contentHash: sha256(stableStringify(historical)),
    }))
    .toSorted((left, right) => left.ref.localeCompare(right.ref));
  const expected = [...lock.resources].toSorted((left, right) => left.ref.localeCompare(right.ref));
  const mismatches = [
    ...new Set([...actual.map(({ ref }) => ref), ...expected.map(({ ref }) => ref)]),
  ].filter((ref) => {
    const left = actual.find((item) => item.ref === ref);
    const right = expected.find((item) => item.ref === ref);
    return (
      left === undefined ||
      right === undefined ||
      left.source !== right.source ||
      left.contentHash !== right.contentHash
    );
  });
  const fingerprint = sha256(
    stableStringify({
      resources: actual.map(({ ref, contentHash }) => ({ ref, contentHash })),
      artifacts: [...lock.artifacts].toSorted((left, right) =>
        left.source.localeCompare(right.source),
      ),
    }),
  );
  if (mismatches.length > 0 || fingerprint !== lock.projectFingerprint) {
    throw new PragmaCompilerMigrationError(
      "lock_mismatch",
      `Compiler v5 project revision does not match its lock: ${mismatches.join(", ") || "project fingerprint"}.`,
    );
  }
  const managed = new Set([
    "pragma.yaml",
    "pragma.lock.yaml",
    ...parsed.map(({ source }) => source),
  ]);
  return {
    resources: parsed.map(({ current }) => current),
    artifacts: new Map([...input.files].filter(([path]) => !managed.has(path))),
  };
}

function extractResources(files: ReadonlyMap<string, string>): readonly ParsedCompilerV5Resource[] {
  const result: ParsedCompilerV5Resource[] = [];
  for (const [source, contents] of files) {
    if (source !== "pragma.yaml" && !source.endsWith(".pragma.yaml")) continue;
    const value = parsePragmaYaml(contents);
    if (isRecord(value) && value["kind"] === "Bundle") {
      const bundle = PragmaV3BundleSchema.safeParse(value);
      if (!bundle.success) throw invalid(source, bundle.error);
      for (const resource of bundle.data.resources) {
        result.push({
          source,
          historical: resource,
          current: migratePragmaV3ResourceToCurrent(resource),
        });
      }
    } else if (isRecord(value) && typeof value["kind"] === "string" && value["kind"] !== "Lock") {
      const resource = PragmaV3SemanticResourceSchema.safeParse(value);
      if (!resource.success) throw invalid(source, resource.error);
      result.push({
        source,
        historical: resource.data,
        current: migratePragmaV3ResourceToCurrent(resource.data),
      });
    }
  }
  return result;
}

function invalid(source: string, cause: unknown): PragmaCompilerMigrationError {
  return new PragmaCompilerMigrationError(
    "invalid_legacy_project",
    `Compiler v5 resource cannot be upgraded to pragma.dsl/v6: ${source}.`,
    { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
