import { canonicalPragmaResourceRef, type PragmaResource } from "../../ast/index.ts";
import { parsePragmaYaml } from "../../compiler/pragma-project.ts";
import { sha256, stableStringify } from "../../compiler/compiler-hash.ts";
import { migratePragmaV4ResourceToCurrent } from "../../migrations/steps/v4-to-v5.ts";
import {
  PragmaCompilerV7BundleSchema,
  PragmaCompilerV7LockSchema,
  PragmaCompilerV7ResourceSchema,
  type PragmaCompilerV7Resource,
} from "../schemas/v7.ts";
import { PragmaCompilerMigrationError } from "../types.ts";

export function migratePragmaCompilerV7Project(input: {
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
      "Compiler v7 project revision is missing pragma.lock.yaml.",
    );
  }
  let lock;
  try {
    lock = PragmaCompilerV7LockSchema.parse(parsePragmaYaml(lockSource));
  } catch (error) {
    throw new PragmaCompilerMigrationError(
      "invalid_legacy_project",
      "Compiler v7 project revision has an invalid pragma.lock.yaml.",
      { cause: error },
    );
  }
  if (input.revisionCompilerVersion !== "pragma.dsl/v7") {
    throw new PragmaCompilerMigrationError(
      "compiler_metadata_mismatch",
      `Project revision metadata declares ${input.revisionCompilerVersion}, but pragma.lock.yaml declares ${lock.compilerVersion}.`,
    );
  }

  const indexed: Array<{
    historical: PragmaCompilerV7Resource;
    resource: PragmaResource;
    source: string;
  }> = [];
  const managed = new Set(["pragma.yaml", "pragma.lock.yaml"]);
  for (const [source, contents] of input.files) {
    if (source !== "pragma.yaml" && !source.endsWith(".pragma.yaml")) continue;
    try {
      const value = parsePragmaYaml(contents);
      if (isRecord(value) && value["kind"] === "Bundle") {
        const bundle = PragmaCompilerV7BundleSchema.parse(value);
        for (const historical of bundle.resources) {
          indexed.push({
            historical,
            resource: migratePragmaV4ResourceToCurrent(historical),
            source,
          });
        }
      } else if (isRecord(value) && typeof value["kind"] === "string" && value["kind"] !== "Lock") {
        const historical = PragmaCompilerV7ResourceSchema.parse(value);
        indexed.push({
          historical,
          resource: migratePragmaV4ResourceToCurrent(historical),
          source,
        });
      } else {
        throw new Error("Expected a pragma/v4 Bundle or semantic resource.");
      }
      managed.add(source);
    } catch (error) {
      throw new PragmaCompilerMigrationError(
        "invalid_legacy_project",
        `Compiler v7 resource cannot be upgraded to pragma.dsl/v8: ${source}.`,
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
  if (actual.size !== lock.resources.length || actual.size !== expected.length) {
    mismatches.push("resource set");
  }
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
      `Compiler v7 project revision does not match its lock: ${mismatches.join(", ") || "project fingerprint"}.`,
    );
  }
  return {
    resources: indexed.map(({ resource }) => resource),
    artifacts: new Map([...input.files].filter(([path]) => !managed.has(path))),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
