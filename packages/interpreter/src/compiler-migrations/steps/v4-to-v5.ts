import { canonicalPragmaResourceRef, type PragmaResource } from "../../ast/index.ts";
import { parsePragmaYaml } from "../../compiler/project-yaml.ts";
import { sha256, stableStringify } from "../../compiler/compiler-hash.ts";
import { PragmaV3LockSchema, PragmaV3SemanticResourceSchema } from "../../migrations/schemas/v3.ts";
import { migratePragmaV3ResourceToCurrent } from "../../migrations/steps/v3-to-v4.ts";
import { PragmaCompilerMigrationError } from "../types.ts";

interface ParsedV4Resource {
  readonly source: string;
  readonly historical: Record<string, unknown>;
  readonly current: PragmaResource;
}

/** Upgrades the last compiler whose ExpertTeam shape did not contain contextStores. */
export function migratePragmaCompilerV4Project(input: {
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
      "Compiler v4 project revision is missing pragma.lock.yaml.",
    );
  }
  const lock = PragmaV3LockSchema.parse(parsePragmaYaml(lockSource));
  if (
    input.revisionCompilerVersion !== "pragma.dsl/v4" ||
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
      `Compiler v4 project revision does not match its lock: ${mismatches.join(", ") || "project fingerprint"}.`,
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

function extractResources(files: ReadonlyMap<string, string>): readonly ParsedV4Resource[] {
  const result: ParsedV4Resource[] = [];
  for (const [source, contents] of files) {
    if (source !== "pragma.yaml" && !source.endsWith(".pragma.yaml")) continue;
    const value = parsePragmaYaml(contents);
    if (isRecord(value) && value["kind"] === "Bundle") {
      const resources = value["resources"];
      if (!Array.isArray(resources)) throw invalid(source);
      for (const resource of resources) result.push(parseResource(resource, source));
    } else if (isRecord(value) && typeof value["kind"] === "string" && value["kind"] !== "Lock") {
      result.push(parseResource(value, source));
    }
  }
  return result;
}

function parseResource(value: unknown, source: string): ParsedV4Resource {
  const historical = PragmaV3SemanticResourceSchema.safeParse(value);
  if (!historical.success) throw invalid(source, historical.error);
  try {
    return {
      source,
      historical: historical.data,
      current: migratePragmaV3ResourceToCurrent(historical.data),
    };
  } catch (error) {
    throw invalid(source, error);
  }
}

function invalid(source: string, cause?: unknown): PragmaCompilerMigrationError {
  return new PragmaCompilerMigrationError(
    "invalid_legacy_project",
    `Compiler v4 resource cannot be upgraded to pragma.dsl/v5: ${source}.`,
    cause === undefined ? undefined : { cause },
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
