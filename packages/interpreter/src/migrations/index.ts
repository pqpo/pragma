import {
  CURRENT_PRAGMA_DSL_API_VERSION,
  PragmaResourceSchema,
  type PragmaResource,
} from "../ast/pragma-dsl.schema.ts";
import { normalizePragmaResourceName } from "../ast/resource-identity.ts";
import { parsePragmaYaml } from "../compiler/pragma-project.ts";
import { pragmaDslV2ToV3Step } from "./steps/v2-to-v3.ts";
import {
  PragmaDslMigrationError,
  type PragmaDslApiVersion,
  type PragmaDslMigrationProject,
  type PragmaDslMigrationStep,
  type PragmaDslProjectMigrationResult,
} from "./types.ts";

export {
  PragmaDslMigrationError,
  type PragmaDslApiVersion,
  type PragmaDslMigrationErrorCode,
  type PragmaDslProjectMigrationResult,
  type PragmaResourceIdentityMigration,
} from "./types.ts";
export {
  createPragmaResourceIdentityMigrationIndex,
  migrateLegacyPragmaResourceRef,
  type PragmaProjectResourceKind,
  type PragmaProjectResourceNamespace,
  type PragmaResourceIdentityMigrationIndex,
} from "./resource-identity-index.ts";

const migrationSteps = [pragmaDslV2ToV3Step] as const satisfies readonly PragmaDslMigrationStep[];
const migrationStepsBySource = indexMigrationSteps(migrationSteps);
const managedKinds = new Set([
  "Expert",
  "ExpertTeam",
  "Flow",
  "Automation",
  "Capability",
  "ContextStore",
  "RuntimeProfile",
]);

export function inspectPragmaProjectApiVersion(
  files: ReadonlyMap<string, string>,
): PragmaDslApiVersion {
  return extractProject(files).apiVersion;
}

export function migratePragmaDslProjectToCurrent(input: {
  readonly projectId: string;
  readonly files: ReadonlyMap<string, string>;
}): PragmaDslProjectMigrationResult {
  if (input.projectId.trim() === "") {
    throw new PragmaDslMigrationError(
      "invalid_legacy_project",
      "Pragma project ID must not be empty.",
    );
  }
  const extracted = extractProject(input.files);
  const sourceApiVersion = extracted.apiVersion;
  let apiVersion = sourceApiVersion;
  let project: PragmaDslMigrationProject = {
    projectId: input.projectId,
    resources: extracted.resources,
    artifacts: extracted.artifacts,
    identityMigrations: [],
  };
  const visited = new Set<PragmaDslApiVersion>();
  while (apiVersion !== CURRENT_PRAGMA_DSL_API_VERSION) {
    if (visited.has(apiVersion)) {
      throw new PragmaDslMigrationError(
        "missing_migration_step",
        `Pragma DSL migration chain contains a cycle at ${apiVersion}.`,
      );
    }
    visited.add(apiVersion);
    const step = migrationStepsBySource.get(apiVersion);
    if (step === undefined) {
      const code =
        compareApiVersions(apiVersion, CURRENT_PRAGMA_DSL_API_VERSION) > 0
          ? "unsupported_api_version"
          : "missing_migration_step";
      throw new PragmaDslMigrationError(
        code,
        `Pragma DSL ${apiVersion} cannot be upgraded to ${CURRENT_PRAGMA_DSL_API_VERSION}.`,
      );
    }
    project = step.migrate(project);
    apiVersion = step.toApiVersion;
  }

  const resources = parseCurrentResources(project.resources);
  assertUniqueResources(resources);
  return {
    sourceApiVersion,
    targetApiVersion: CURRENT_PRAGMA_DSL_API_VERSION,
    migrated: sourceApiVersion !== CURRENT_PRAGMA_DSL_API_VERSION,
    resources,
    artifacts: new Map(project.artifacts),
    identityMigrations: project.identityMigrations,
  };
}

function extractProject(files: ReadonlyMap<string, string>): {
  readonly apiVersion: PragmaDslApiVersion;
  readonly resources: readonly unknown[];
  readonly artifacts: ReadonlyMap<string, string>;
} {
  const versions = new Set<PragmaDslApiVersion>();
  const resources: unknown[] = [];
  const managedPaths = new Set<string>(["pragma.yaml", "pragma.lock.yaml"]);
  for (const [path, source] of files) {
    if (path === "pragma.lock.yaml") continue;
    if (path !== "pragma.yaml" && !path.endsWith(".pragma.yaml")) continue;
    let value: unknown;
    try {
      value = parsePragmaYaml(source);
    } catch (error) {
      throw new PragmaDslMigrationError(
        "invalid_legacy_project",
        `Cannot parse Pragma DSL source: ${path}.`,
        { cause: error },
      );
    }
    if (typeof value !== "object" || value === null) continue;
    const document = value as Record<string, unknown>;
    const kind = document["kind"];
    if (kind !== "Bundle" && (typeof kind !== "string" || !managedKinds.has(kind))) continue;
    managedPaths.add(path);
    versions.add(parseApiVersion(document["apiVersion"], path));
    if (kind === "Bundle") {
      const inlineResources = document["resources"];
      if (inlineResources !== undefined) {
        if (!Array.isArray(inlineResources)) {
          throw new PragmaDslMigrationError(
            "invalid_legacy_project",
            `Pragma Bundle resources must be an array: ${path}.`,
          );
        }
        for (const resource of inlineResources) {
          resources.push(resource);
          if (typeof resource === "object" && resource !== null) {
            versions.add(
              parseApiVersion((resource as Record<string, unknown>)["apiVersion"], path),
            );
          }
        }
      }
      continue;
    }
    resources.push(value);
  }
  if (versions.size === 0) {
    throw new PragmaDslMigrationError(
      "invalid_legacy_project",
      "Pragma project does not contain a versioned Bundle or semantic resource.",
    );
  }
  if (versions.size !== 1) {
    throw new PragmaDslMigrationError(
      "mixed_api_versions",
      `Pragma project mixes DSL API versions: ${[...versions].toSorted().join(", ")}.`,
    );
  }
  const apiVersion = [...versions][0]!;
  const artifacts = new Map([...files].filter(([path]) => !managedPaths.has(path)));
  return { apiVersion, resources, artifacts };
}

function parseApiVersion(value: unknown, path: string): PragmaDslApiVersion {
  if (typeof value !== "string" || !/^pragma\/v[1-9][0-9]*$/u.test(value)) {
    throw new PragmaDslMigrationError(
      "unsupported_api_version",
      `Pragma source has an unsupported apiVersion in ${path}.`,
    );
  }
  return value as PragmaDslApiVersion;
}

function parseCurrentResources(resources: readonly unknown[]): readonly PragmaResource[] {
  return resources.map((resource) => {
    const parsed = PragmaResourceSchema.safeParse(resource);
    if (!parsed.success) {
      throw new PragmaDslMigrationError(
        "invalid_migrated_project",
        `Pragma project is not valid ${CURRENT_PRAGMA_DSL_API_VERSION}.`,
        { cause: parsed.error },
      );
    }
    return parsed.data;
  });
}

function assertUniqueResources(resources: readonly PragmaResource[]): void {
  const identities = new Set<string>();
  const names = new Set<string>();
  for (const resource of resources) {
    const identity = `${resource.kind}\0${resource.metadata.id}`;
    if (identities.has(identity)) {
      throw new PragmaDslMigrationError(
        "identity_conflict",
        `Duplicate Pragma resource identity: ${resource.kind} ${resource.metadata.id}.`,
      );
    }
    const name = `${resource.kind}\0${normalizePragmaResourceName(resource.metadata.name)}`;
    if (names.has(name)) {
      throw new PragmaDslMigrationError(
        "name_conflict",
        `Duplicate normalized Pragma resource name: ${resource.kind} ${resource.metadata.name}.`,
      );
    }
    identities.add(identity);
    names.add(name);
  }
}

function compareApiVersions(left: PragmaDslApiVersion, right: PragmaDslApiVersion): number {
  return Number(left.slice("pragma/v".length)) - Number(right.slice("pragma/v".length));
}

function indexMigrationSteps(
  steps: readonly PragmaDslMigrationStep[],
): ReadonlyMap<PragmaDslApiVersion, PragmaDslMigrationStep> {
  const indexed = new Map<PragmaDslApiVersion, PragmaDslMigrationStep>();
  for (const step of steps) {
    if (compareApiVersions(step.toApiVersion, step.fromApiVersion) !== 1) {
      throw new Error(
        `Pragma DSL migrations must be adjacent: ${step.fromApiVersion} -> ${step.toApiVersion}.`,
      );
    }
    if (indexed.has(step.fromApiVersion)) {
      throw new Error(`Duplicate Pragma DSL migration from ${step.fromApiVersion}.`);
    }
    indexed.set(step.fromApiVersion, step);
  }
  return indexed;
}
