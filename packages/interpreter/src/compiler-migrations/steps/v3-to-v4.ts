import { canonicalPragmaResourceRef, type PragmaResource } from "../../ast/index.ts";
import { parsePragmaYaml } from "../../compiler/pragma-project.ts";
import { sha256, stableStringify } from "../../compiler/compiler-hash.ts";
import {
  PragmaV3BundleSchema,
  PragmaV3LockSchema,
  PragmaV3SemanticResourceSchema,
  type PragmaV3SemanticResource,
} from "../../migrations/schemas/v3.ts";
import { migratePragmaV3ResourceToCurrent } from "../../migrations/steps/v3-to-v4.ts";
import { PragmaCompilerMigrationError } from "../types.ts";

export function migratePragmaCompilerV3Project(input: {
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
      "Compiler v3 project revision is missing pragma.lock.yaml.",
    );
  }
  const lock = PragmaV3LockSchema.parse(parsePragmaYaml(lockSource));
  if (
    input.revisionCompilerVersion !== "pragma.dsl/v3" ||
    lock.compilerVersion !== input.revisionCompilerVersion
  ) {
    throw new PragmaCompilerMigrationError(
      "compiler_metadata_mismatch",
      `Project revision metadata declares ${input.revisionCompilerVersion}, but pragma.lock.yaml declares ${lock.compilerVersion}.`,
    );
  }

  const indexed: {
    readonly historical: PragmaV3SemanticResource;
    readonly resource: PragmaResource;
    readonly source: string;
  }[] = [];
  const managed = new Set(["pragma.yaml", "pragma.lock.yaml"]);
  for (const [source, contents] of input.files) {
    if (source !== "pragma.yaml" && !source.endsWith(".pragma.yaml")) continue;
    const value = parsePragmaYaml(contents);
    try {
      if (isRecord(value) && value["kind"] === "Bundle") {
        const bundle = PragmaV3BundleSchema.parse(value);
        for (const historical of bundle.resources) {
          indexed.push({
            historical,
            resource: migratePragmaV3ResourceToCurrent(historical),
            source,
          });
        }
      } else if (isRecord(value) && typeof value["kind"] === "string" && value["kind"] !== "Lock") {
        const historical = PragmaV3SemanticResourceSchema.parse(value);
        indexed.push({
          historical,
          resource: migratePragmaV3ResourceToCurrent(historical),
          source,
        });
      }
      managed.add(source);
    } catch (error) {
      throw new PragmaCompilerMigrationError(
        "invalid_legacy_project",
        `Compiler v3 resource cannot be upgraded to pragma.dsl/v4: ${source}. ${firstIssue(error)}`,
        { cause: error },
      );
    }
  }

  const expected = indexed
    .map(({ historical, resource, source }) => ({
      ref: canonicalPragmaResourceRef(resource),
      contentHash: sha256(stableStringify(historical)),
      source,
    }))
    .toSorted((left, right) => left.ref.localeCompare(right.ref));
  const actual = new Map(lock.resources.map((resource) => [resource.ref, resource]));
  const mismatches = expected
    .filter((resource) => {
      const locked = actual.get(resource.ref);
      return (
        locked === undefined ||
        locked.source !== resource.source ||
        locked.contentHash !== resource.contentHash
      );
    })
    .map(({ ref }) => ref);
  if (actual.size !== expected.length) mismatches.push("resource set");
  const fingerprint = sha256(
    stableStringify({
      resources: expected.map(({ ref, contentHash }) => ({ ref, contentHash })),
      artifacts: [...lock.artifacts].toSorted((left, right) =>
        left.source.localeCompare(right.source),
      ),
    }),
  );
  if (mismatches.length > 0 || fingerprint !== lock.projectFingerprint) {
    throw new PragmaCompilerMigrationError(
      "lock_mismatch",
      `Compiler v3 project revision does not match its lock: ${mismatches.join(", ") || "project fingerprint"}.`,
    );
  }
  return {
    resources: indexed.map(({ resource }) => resource),
    artifacts: new Map([...input.files].filter(([path]) => !managed.has(path))),
  };
}

function firstIssue(error: unknown): string {
  if (!isRecord(error)) return "The resource is invalid.";
  if (!Array.isArray(error["issues"])) {
    return "cause" in error ? firstIssue(error["cause"]) : "The resource is invalid.";
  }
  const issue = error["issues"][0];
  if (!isRecord(issue)) return "The resource is invalid.";
  const path = Array.isArray(issue["path"]) ? issue["path"].join(".") : "resource";
  return `${path}: ${String(issue["message"] ?? "invalid value")}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
