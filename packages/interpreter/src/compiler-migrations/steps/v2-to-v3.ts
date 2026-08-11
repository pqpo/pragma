import { canonicalPragmaResourceRef, type PragmaResource } from "../../ast/index.ts";
import { parsePragmaYaml } from "../../compiler/pragma-project.ts";
import { sha256, stableStringify } from "../../compiler/compiler-hash.ts";
import { PragmaV3LockSchema } from "../../migrations/schemas/v3.ts";
import { migratePragmaV3ResourceToCurrent } from "../../migrations/steps/v3-to-v4.ts";
import { PragmaCompilerV2FlowRunDrySuiteSchema } from "../schemas/v2.ts";
import { PragmaCompilerMigrationError } from "../types.ts";

interface ParsedCompilerV2Resource {
  readonly source: string;
  readonly historical: unknown;
  readonly current: PragmaResource;
}

export function migratePragmaCompilerV2Project(input: {
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
      "Compiler v2 project revision is missing pragma.lock.yaml.",
    );
  }
  let lock;
  try {
    lock = PragmaV3LockSchema.parse(parsePragmaYaml(lockSource));
  } catch (error) {
    throw new PragmaCompilerMigrationError(
      "invalid_legacy_project",
      "Compiler v2 project revision has an invalid pragma.lock.yaml.",
      { cause: error },
    );
  }
  if (
    input.revisionCompilerVersion !== "pragma.dsl/v2" ||
    lock.compilerVersion !== input.revisionCompilerVersion
  ) {
    throw new PragmaCompilerMigrationError(
      "compiler_metadata_mismatch",
      `Project revision metadata declares ${input.revisionCompilerVersion}, but pragma.lock.yaml declares ${lock.compilerVersion}.`,
    );
  }

  const parsedResources = extractCompilerV2Resources(input.files);
  const actualByRef = new Map(
    parsedResources.map((parsed) => {
      const ref = canonicalPragmaResourceRef(parsed.current);
      return [
        ref,
        {
          ref,
          source: parsed.source,
          contentHash: sha256(stableStringify(parsed.historical)),
        },
      ] as const;
    }),
  );
  const expectedByRef = new Map(lock.resources.map((resource) => [resource.ref, resource]));
  const mismatches = [...new Set([...actualByRef.keys(), ...expectedByRef.keys()])].filter(
    (ref) => {
      const actual = actualByRef.get(ref);
      const expected = expectedByRef.get(ref);
      return (
        actual === undefined ||
        expected === undefined ||
        actual.source !== expected.source ||
        actual.contentHash !== expected.contentHash
      );
    },
  );
  const expectedProjectFingerprint = sha256(
    stableStringify({
      resources: lock.resources
        .map(({ ref, contentHash }) => ({ ref, contentHash }))
        .toSorted((left, right) => left.ref.localeCompare(right.ref)),
      artifacts: [...lock.artifacts].toSorted((left, right) =>
        left.source.localeCompare(right.source),
      ),
    }),
  );
  if (mismatches.length > 0 || expectedProjectFingerprint !== lock.projectFingerprint) {
    throw new PragmaCompilerMigrationError(
      "lock_mismatch",
      `Compiler v2 project revision does not match its lock: ${mismatches.join(", ") || "project fingerprint"}.`,
    );
  }

  const managed = new Set([
    "pragma.yaml",
    "pragma.lock.yaml",
    ...parsedResources.map((resource) => resource.source),
  ]);
  return {
    resources: parsedResources.map((resource) => resource.current),
    artifacts: new Map([...input.files].filter(([path]) => !managed.has(path))),
  };
}

function extractCompilerV2Resources(
  files: ReadonlyMap<string, string>,
): readonly ParsedCompilerV2Resource[] {
  const resources: ParsedCompilerV2Resource[] = [];
  let sawBundle = false;
  for (const [source, contents] of files) {
    if (source !== "pragma.yaml" && !source.endsWith(".pragma.yaml")) continue;
    let value: unknown;
    try {
      value = parsePragmaYaml(contents);
    } catch (error) {
      throw new PragmaCompilerMigrationError(
        "invalid_legacy_project",
        `Cannot parse compiler v2 source: ${source}.`,
        { cause: error },
      );
    }
    if (isRecord(value) && value["kind"] === "Bundle") {
      sawBundle = true;
      if (value["apiVersion"] !== "pragma/v3" || !Array.isArray(value["resources"])) {
        throw new PragmaCompilerMigrationError(
          "invalid_legacy_project",
          `Compiler v2 Bundle is invalid: ${source}.`,
        );
      }
      for (const resource of value["resources"])
        resources.push(parseCompilerV2Resource(resource, source));
      continue;
    }
    if (isRecord(value) && typeof value["kind"] === "string" && value["kind"] !== "Lock") {
      resources.push(parseCompilerV2Resource(value, source));
    }
  }
  if (resources.length === 0 && !sawBundle) {
    throw new PragmaCompilerMigrationError(
      "invalid_legacy_project",
      "Compiler v2 project revision does not contain a semantic resource.",
    );
  }
  return resources;
}

function parseCompilerV2Resource(value: unknown, source: string): ParsedCompilerV2Resource {
  const historical = structuredClone(value);
  const candidate = structuredClone(value);
  if (
    isRecord(historical) &&
    historical["kind"] === "Flow" &&
    isRecord(historical["spec"]) &&
    "runDry" in historical["spec"]
  ) {
    try {
      historical["spec"]["runDry"] = PragmaCompilerV2FlowRunDrySuiteSchema.parse(
        historical["spec"]["runDry"],
      );
    } catch (error) {
      throw new PragmaCompilerMigrationError(
        "invalid_legacy_project",
        `Compiler v2 Flow has an invalid spec.runDry: ${source}.`,
        { cause: error },
      );
    }
    if (isRecord(candidate) && isRecord(candidate["spec"])) delete candidate["spec"]["runDry"];
  }
  let current: PragmaResource;
  try {
    current = migratePragmaV3ResourceToCurrent(candidate);
  } catch (error) {
    throw new PragmaCompilerMigrationError(
      "invalid_legacy_project",
      `Compiler v2 resource cannot be upgraded: ${source}.`,
      { cause: error },
    );
  }
  const downgraded = downgradeCurrentResourceToV3(current);
  const normalizedHistorical: unknown =
    current.kind === "Flow" &&
    isRecord(historical) &&
    isRecord(historical["spec"]) &&
    "runDry" in historical["spec"]
      ? {
          ...downgraded,
          spec: { ...(downgraded["spec"] as object), runDry: historical["spec"]["runDry"] },
        }
      : withoutV5TeamFields(downgraded);
  return { source, historical: normalizedHistorical, current };
}

function downgradeCurrentResourceToV3(resource: PragmaResource): Record<string, unknown> {
  const historical = structuredClone(resource) as Record<string, unknown>;
  historical["apiVersion"] = "pragma/v3";
  if (
    (historical["kind"] === "Expert" || historical["kind"] === "ExpertTeam") &&
    isRecord(historical["metadata"])
  ) {
    delete historical["metadata"]["avatarId"];
  }
  return historical;
}

function withoutV5TeamFields(resource: Record<string, unknown>): unknown {
  if (resource["kind"] !== "ExpertTeam") return resource;
  const historical = structuredClone(resource);
  if (isRecord(historical["spec"])) delete historical["spec"]["contextStores"];
  return historical;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
