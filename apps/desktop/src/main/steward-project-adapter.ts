import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import {
  PragmaCapabilityResourceSchema,
  PragmaResourceSchema,
  PragmaRuntimeProfileResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import {
  StewardChangeSetSchema,
  StewardExpertOptionCatalogSchema,
  StewardProjectCommitSchema,
  type StewardDslProjectPort,
  type StewardExpertOptionCatalog,
} from "@pragma/steward";
import { z } from "zod";

import type { Capability } from "../shared/desktop-api.ts";
import {
  desktopCapabilityBindingRef,
  parseDesktopCapabilityBindingRef,
} from "./desktop-binding-ref.ts";
import type { CapabilityStore } from "./capability-store.ts";
import type { PragmaProjectStore } from "./pragma-project-store.ts";
import { getRuntimeAvailability } from "./runtime-availability.ts";
import type { RuntimeEnvironmentService } from "./runtime-environment-service.ts";

const CandidateRecordSchema = z.object({
  changeSet: StewardChangeSetSchema,
  resources: z.array(PragmaResourceSchema),
});

export function createDesktopStewardProjectPort(options: {
  readonly project: PragmaProjectStore;
  readonly stateRoot: string;
  readonly capabilities: CapabilityStore;
  readonly runtimes: RuntimeEnvironmentService;
}): StewardDslProjectPort {
  const candidatePath = (id: string) =>
    join(options.stateRoot, "change-sets", `${encodePragmaPathSegment(id)}.json`);
  const operationPath = (id: string) =>
    join(options.stateRoot, "operations", `${encodePragmaPathSegment(id)}.json`);

  return {
    async list() {
      const snapshot = await options.project.get();
      return {
        projectRevision: snapshot.revision,
        resources: snapshot.resources.map((resource) => ({
          ref: canonicalPragmaResourceRef(resource),
          kind: resource.kind,
          name: resource.metadata.name,
          description: resource.metadata.description,
          version: resource.metadata.version,
        })),
      };
    },
    async read(ref) {
      const snapshot = await options.project.get();
      const resource = snapshot.resources.find(
        (candidate) => canonicalPragmaResourceRef(candidate) === ref,
      );
      if (resource === undefined) throw new Error(`Pragma resource not found: ${ref}`);
      return {
        ref: canonicalPragmaResourceRef(resource),
        kind: resource.kind,
        name: resource.metadata.name,
        description: resource.metadata.description,
        version: resource.metadata.version,
        projectRevision: snapshot.revision,
        source: formatPragmaYaml(resource),
      };
    },
    async listExpertOptions() {
      return (await buildExpertCatalog(options)).options;
    },
    async prepare(input) {
      const snapshot = await options.project.get();
      if (snapshot.revision !== input.expectedProjectRevision) {
        throw new Error(
          `Project revision changed from ${input.expectedProjectRevision} to ${snapshot.revision}.`,
        );
      }
      const authoredResources = input.sources.map(parseStewardResource);
      const catalog = await buildExpertCatalog(options);
      const knownRefs = new Set([
        ...snapshot.resources.map(canonicalPragmaResourceRef),
        ...authoredResources.map(canonicalPragmaResourceRef),
      ]);
      const dependencies = authoredResources
        .filter((resource): resource is PragmaExpertResource => resource.kind === "Expert")
        .flatMap(expertDependencyRefs)
        .flatMap((ref) => {
          if (knownRefs.has(ref)) return [];
          const dependency = catalog.resources.get(ref);
          if (dependency === undefined) return [];
          knownRefs.add(ref);
          return [dependency];
        });
      const resources = [...authoredResources, ...dependencies];
      const refs = resources.map(canonicalPragmaResourceRef);
      if (new Set(refs).size !== refs.length) throw new Error("A change-set cannot repeat a ref.");
      assertExpertSelectionsAvailable(authoredResources, snapshot.resources, resources, catalog);
      const diagnostics = await options.project.service.validateCandidate({
        projectId: options.project.projectId,
        expectedRevision: snapshot.revision,
        upserts: resources,
      });
      const existing = new Set(snapshot.resources.map(canonicalPragmaResourceRef));
      const changeSet = StewardChangeSetSchema.parse({
        changeSetId: randomUUID(),
        projectRevision: snapshot.revision,
        diagnostics,
        changes: resources.map((resource) => ({
          ref: canonicalPragmaResourceRef(resource),
          kind: existing.has(canonicalPragmaResourceRef(resource)) ? "updated" : "created",
          source: formatPragmaYaml(resource),
        })),
        createdAt: new Date().toISOString(),
      });
      await writeJson(candidatePath(changeSet.changeSetId), { changeSet, resources });
      return changeSet;
    },
    async getChangeSet(changeSetId) {
      return (await readCandidate(candidatePath(changeSetId))).changeSet;
    },
    async commit(input) {
      const path = operationPath(input.operationId);
      return await withFileLock(`${path}.lock`, async () => {
        const completed = await readJson(path);
        if (completed !== undefined) return StewardProjectCommitSchema.parse(completed);
        const candidate = await readCandidate(candidatePath(input.changeSetId));
        if (candidate.changeSet.diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
          throw new Error("The prepared DSL change-set contains validation errors.");
        }
        const snapshot = await options.project.get();
        const catalog = await buildExpertCatalog(options);
        assertExpertSelectionsAvailable(
          candidate.resources,
          snapshot.resources,
          candidate.resources,
          catalog,
        );
        const published = await options.project.service.apply({
          projectId: options.project.projectId,
          expectedRevision: candidate.changeSet.projectRevision,
          upserts: candidate.resources,
        });
        const result = StewardProjectCommitSchema.parse({
          projectId: published.projectId,
          projectRevision: published.revision,
          changedRefs: candidate.changeSet.changes.map((change) => change.ref),
        });
        await writeJson(path, result);
        return result;
      });
    },
  };
}

interface DesktopExpertCatalog {
  readonly options: StewardExpertOptionCatalog;
  readonly resources: ReadonlyMap<string, PragmaResource>;
  readonly availableModels: ReadonlySet<string>;
  readonly readyCapabilityIds: ReadonlySet<string>;
}

async function buildExpertCatalog(options: {
  readonly capabilities: CapabilityStore;
  readonly runtimes: RuntimeEnvironmentService;
}): Promise<DesktopExpertCatalog> {
  const [availability, capabilities] = await Promise.all([
    getRuntimeAvailability(options.runtimes),
    options.capabilities.list(),
  ]);
  const resources = new Map<string, PragmaResource>();
  const runtimeModels = availability
    .filter((runtime) => runtime.status === "available")
    .flatMap((runtime) =>
      (runtime.models ?? []).map((model) => {
        const identity = runtimeModelIdentity(runtime.id, model.provider.id, model.id);
        const id = `runtime_${createHash("sha256").update(identity).digest("hex")}`;
        const resource = PragmaRuntimeProfileResourceSchema.parse({
          apiVersion: "pragma/v2",
          kind: "RuntimeProfile",
          metadata: {
            id,
            version: "1.0.0",
            name: `${runtime.displayName} / ${model.displayName}`,
            description: `Host-provided Runtime model ${model.provider.displayName} / ${model.displayName}.`,
            tags: ["desktop-managed", "steward-option"],
          },
          spec: {
            adapter: "pragma.runtime.profile@v1",
            config: {
              runtimeId: runtime.id,
              providerId: model.provider.id,
              model: model.id,
            },
          },
        });
        const ref = canonicalPragmaResourceRef(resource);
        resources.set(ref, resource);
        return {
          key: ref,
          runtimeProfileRef: ref,
          runtimeName: runtime.displayName,
          providerName: model.provider.displayName,
          modelName: model.displayName,
          isDefault: runtime.isDefault && model.default === true,
        };
      }),
    );
  const readyCapabilities = capabilities.filter(
    (capability) => capability.health.status === "ready",
  );
  const capabilityOptions = readyCapabilities.map((capability) => {
    const resource = capabilityResource(capability);
    const ref = canonicalPragmaResourceRef(resource);
    resources.set(ref, resource);
    const toolNames = capabilityToolNames(capability);
    return {
      key: ref,
      ref,
      name: capability.definition.name,
      description: capability.definition.description,
      kind: capability.definition.kind === "skill" ? ("skill" as const) : ("tools" as const),
      toolNames,
    };
  });
  return {
    options: StewardExpertOptionCatalogSchema.parse({
      runtimeModels,
      capabilities: capabilityOptions,
    }),
    resources,
    availableModels: new Set(
      availability
        .filter((runtime) => runtime.status === "available")
        .flatMap((runtime) =>
          (runtime.models ?? []).map((model) =>
            runtimeModelIdentity(runtime.id, model.provider.id, model.id),
          ),
        ),
    ),
    readyCapabilityIds: new Set(readyCapabilities.map((capability) => capability.manifest.id)),
  };
}

function capabilityResource(capability: Capability): PragmaResource {
  return PragmaCapabilityResourceSchema.parse({
    apiVersion: "pragma/v2",
    kind: "Capability",
    metadata: {
      id: `capability_${capability.manifest.id.replaceAll("-", "")}`,
      version: String(capability.manifest.latestRevision),
      name: capability.definition.name,
      description: capability.definition.description,
      tags: ["desktop-managed", "steward-option"],
    },
    spec: {
      adapter: "pragma.capability.host@v1",
      binding: desktopCapabilityBindingRef(
        capability.manifest.id,
        capability.manifest.latestRevision,
      ),
      config: { key: capability.manifest.id },
    },
  });
}

function capabilityToolNames(capability: Capability): string[] {
  switch (capability.definition.kind) {
    case "skill":
      return [];
    case "code_service":
      return [capability.definition.tool.name];
    case "mcp_server":
    case "http_service":
      return capability.definition.tools.map((tool) => tool.name);
  }
}

function expertDependencyRefs(resource: PragmaExpertResource): string[] {
  return [
    ...(resource.spec.runtime === undefined ? [] : [resource.spec.runtime.ref]),
    ...resource.spec.capabilities.map((capability) => capability.ref),
  ];
}

function assertExpertSelectionsAvailable(
  authored: readonly PragmaResource[],
  current: readonly PragmaResource[],
  dependencies: readonly PragmaResource[],
  catalog: DesktopExpertCatalog,
): void {
  const byRef = new Map(
    [...current, ...dependencies].map((resource) => [
      canonicalPragmaResourceRef(resource),
      resource,
    ]),
  );
  for (const expert of authored.filter(
    (resource): resource is PragmaExpertResource => resource.kind === "Expert",
  )) {
    if (expert.spec.runtime === undefined) {
      throw new Error(`Expert ${expert.metadata.id} must select a Runtime model.`);
    }
    const runtime = byRef.get(expert.spec.runtime.ref);
    if (runtime?.kind !== "RuntimeProfile") {
      throw new Error(`Expert Runtime profile is unavailable: ${expert.spec.runtime.ref}.`);
    }
    const config = runtime.spec.config as {
      runtimeId?: unknown;
      providerId?: unknown;
      model?: unknown;
    };
    if (
      typeof config.runtimeId !== "string" ||
      typeof config.providerId !== "string" ||
      typeof config.model !== "string" ||
      !catalog.availableModels.has(
        runtimeModelIdentity(config.runtimeId, config.providerId, config.model),
      )
    ) {
      throw new Error(`Expert Runtime model is unavailable: ${expert.spec.runtime.ref}.`);
    }
    for (const reference of expert.spec.capabilities) {
      const capability = byRef.get(reference.ref);
      if (capability?.kind !== "Capability") continue;
      const binding = parseDesktopCapabilityBindingRef(capability.spec.binding ?? "");
      if (binding !== undefined && !catalog.readyCapabilityIds.has(binding.id)) {
        throw new Error(`Expert capability is unavailable: ${reference.ref}.`);
      }
    }
  }
}

function runtimeModelIdentity(runtimeId: string, providerId: string, modelId: string): string {
  return JSON.stringify([runtimeId, providerId, modelId]);
}

function parseStewardResource(source: string): PragmaResource {
  const resource = PragmaResourceSchema.parse(parsePragmaYaml(source));
  if (resource.kind !== "Expert" && resource.kind !== "ExpertTeam" && resource.kind !== "Flow") {
    throw new Error("Steward v1 can only create or update Expert, ExpertTeam, and Flow resources.");
  }
  return resource;
}

async function readCandidate(path: string): Promise<z.infer<typeof CandidateRecordSchema>> {
  const value = await readJson(path);
  if (value === undefined) throw new Error("Prepared DSL change-set not found.");
  return CandidateRecordSchema.parse(value);
}

async function readJson(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}
