import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { encodePragmaPathSegment, withFileLock } from "@pragma/core";
import { formatPragmaYaml, parsePragmaYaml } from "@pragma/interpreter";
import {
  analyzePragmaFlowGraph,
  PragmaCapabilityResourceSchema,
  PragmaFlowResourceSchema,
  PragmaResourceSchema,
  PragmaRuntimeProfileResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaFlowResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import {
  DefaultAgentChangeSetSchema,
  DefaultAgentExpertOptionCatalogSchema,
  DefaultAgentFlowDraftSchema,
  DefaultAgentPrepareResultSchema,
  DefaultAgentProjectCommitSchema,
  type DefaultAgentDslProjectPort,
  type DefaultAgentExpertOptionCatalog,
  type DefaultAgentFlowDraft,
  type DefaultAgentFlowDraftDiagnostic,
  type DefaultAgentFlowDraftOperation,
  type DefaultAgentPrepareResult,
} from "@pragma/default-agent";
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
  changeSet: DefaultAgentChangeSetSchema,
  resources: z.array(PragmaResourceSchema),
});

export function createDesktopDefaultAgentProjectPort(options: {
  readonly project: PragmaProjectStore;
  readonly stateRoot: string;
  readonly capabilities: CapabilityStore;
  readonly runtimes: RuntimeEnvironmentService;
}): DefaultAgentDslProjectPort {
  const candidatePath = (id: string) =>
    join(options.stateRoot, "change-sets", `${encodePragmaPathSegment(id)}.json`);
  const operationPath = (id: string) =>
    join(options.stateRoot, "operations", `${encodePragmaPathSegment(id)}.json`);
  const draftPath = (id: string) =>
    join(options.stateRoot, "dsl-drafts", `${encodePragmaPathSegment(id)}.json`);

  const prepareResources = async (input: {
    readonly expectedProjectRevision: number;
    readonly authoredResources: readonly PragmaResource[];
  }): Promise<DefaultAgentPrepareResult> => {
    const snapshot = await options.project.get();
    if (snapshot.revision !== input.expectedProjectRevision) {
      return invalidPrepare(
        "project.revision_conflict",
        `Project revision changed from ${input.expectedProjectRevision} to ${snapshot.revision}.`,
      );
    }
    const authoredResources = [...input.authoredResources];
    const actionDiagnostics = authoredResources.flatMap((resource) =>
      resource.kind !== "Flow"
        ? []
        : Object.entries(resource.spec.graph.steps).flatMap(([stepId, step]) =>
            step.action === undefined
              ? []
              : [
                  {
                    severity: "error" as const,
                    code: "environment.flow_action_unavailable",
                    message: "Action steps are not executable in the current Desktop environment.",
                    path: ["spec", "graph", "steps", stepId, "action"],
                  },
                ],
          ),
    );
    if (actionDiagnostics.length > 0) {
      return DefaultAgentPrepareResultSchema.parse({
        status: "invalid",
        diagnostics: actionDiagnostics,
      });
    }
    try {
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
      if (new Set(refs).size !== refs.length) {
        return invalidPrepare("resource.duplicate", "A change-set cannot repeat a ref.");
      }
      assertExpertSelectionsAvailable(authoredResources, snapshot.resources, resources, catalog);
      const diagnostics = await options.project.validateChanges({
        expectedRevision: snapshot.revision,
        upserts: resources,
      });
      if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
        return DefaultAgentPrepareResultSchema.parse({ status: "invalid", diagnostics });
      }
      const existing = new Set(snapshot.resources.map(canonicalPragmaResourceRef));
      const changeSet = DefaultAgentChangeSetSchema.parse({
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
      return DefaultAgentPrepareResultSchema.parse({ status: "prepared", changeSet });
    } catch (error) {
      return DefaultAgentPrepareResultSchema.parse({
        status: "invalid",
        diagnostics: diagnosticsFromError(error),
      });
    }
  };

  const prepareSources = async (input: {
    readonly expectedProjectRevision: number;
    readonly sources: readonly string[];
  }): Promise<DefaultAgentPrepareResult> => {
    const parsed = parseDefaultAgentSources(input.sources);
    if (parsed.diagnostics.length > 0) {
      return DefaultAgentPrepareResultSchema.parse({
        status: "invalid",
        diagnostics: parsed.diagnostics,
      });
    }
    return await prepareResources({
      expectedProjectRevision: input.expectedProjectRevision,
      authoredResources: parsed.resources,
    });
  };

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
      return await prepareSources(input);
    },
    async createFlowDraft(input) {
      const snapshot = await options.project.get();
      if (snapshot.revision !== input.expectedProjectRevision) {
        throw new Error(
          `Project revision changed from ${input.expectedProjectRevision} to ${snapshot.revision}.`,
        );
      }
      const now = new Date().toISOString();
      const draftId = randomUUID();
      const draft = withDraftDiagnostics({
        draftId,
        baseProjectRevision: snapshot.revision,
        draftRevision: 0,
        resource: {
          apiVersion: "pragma/v2",
          kind: "Flow",
          metadata: input.metadata,
          spec: {
            ...(input.input === undefined ? {} : { input: input.input }),
            ...(input.output === undefined ? {} : { output: input.output }),
            limits: input.limits ?? { maxNodeVisits: 1_000 },
            graph: { steps: {}, transitions: {}, loops: {} },
          },
        },
        diagnostics: [],
        createdAt: now,
        updatedAt: now,
      });
      await writeJson(draftPath(draftId), draft);
      return draft;
    },
    async getFlowDraft(draftId) {
      return withDraftDiagnostics(await readFlowDraft(draftPath(draftId)));
    },
    async updateFlowDraft(input) {
      const path = draftPath(input.draftId);
      return await withFileLock(`${path}.lock`, async () => {
        const current = await readFlowDraft(path);
        if (current.draftRevision !== input.expectedDraftRevision) {
          throw new Error(
            `Flow draft revision changed from ${input.expectedDraftRevision} to ${current.draftRevision}.`,
          );
        }
        const resource = structuredClone(current.resource);
        let baseProjectRevision = current.baseProjectRevision;
        for (const operation of input.operations) {
          baseProjectRevision = applyDraftOperation(resource, operation, baseProjectRevision);
        }
        if (baseProjectRevision !== current.baseProjectRevision) {
          const snapshot = await options.project.get();
          if (snapshot.revision !== baseProjectRevision) {
            throw new Error(
              `Cannot rebase Flow draft to unavailable revision ${baseProjectRevision}.`,
            );
          }
        }
        const updated = withDraftDiagnostics({
          ...current,
          baseProjectRevision,
          draftRevision: current.draftRevision + 1,
          resource,
          updatedAt: new Date().toISOString(),
        });
        await writeJson(path, updated);
        return updated;
      });
    },
    async validateFlowDraft(draftId) {
      return withDraftDiagnostics(await readFlowDraft(draftPath(draftId)));
    },
    async prepareFlowDraft(input) {
      const draft = withDraftDiagnostics(await readFlowDraft(draftPath(input.draftId)));
      if (draft.draftRevision !== input.expectedDraftRevision) {
        return invalidPrepare(
          "flow.draft.revision_conflict",
          `Flow draft revision changed from ${input.expectedDraftRevision} to ${draft.draftRevision}.`,
        );
      }
      if (draft.diagnostics.some((diagnostic) => diagnostic.severity !== "warning")) {
        return DefaultAgentPrepareResultSchema.parse({
          status: "invalid",
          diagnostics: draft.diagnostics.map((diagnostic) => ({
            severity: diagnostic.severity === "warning" ? "warning" : "error",
            code: diagnostic.code,
            message: diagnostic.message,
            path: diagnostic.path,
          })),
        });
      }
      const additional = parseDefaultAgentSources(input.additionalSources ?? [], 1);
      if (additional.diagnostics.length > 0) {
        return DefaultAgentPrepareResultSchema.parse({
          status: "invalid",
          diagnostics: additional.diagnostics,
        });
      }
      return await prepareResources({
        expectedProjectRevision: draft.baseProjectRevision,
        authoredResources: [
          PragmaFlowResourceSchema.parse(materializeDraft(draft)),
          ...additional.resources,
        ],
      });
    },
    async discardFlowDraft(draftId) {
      const path = draftPath(draftId);
      await withFileLock(`${path}.lock`, async () => await rm(path, { force: true }));
    },
    async getChangeSet(changeSetId) {
      return (await readCandidate(candidatePath(changeSetId))).changeSet;
    },
    async commit(input) {
      const path = operationPath(input.operationId);
      return await withFileLock(`${path}.lock`, async () => {
        const completed = await readJson(path);
        if (completed !== undefined) return DefaultAgentProjectCommitSchema.parse(completed);
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
        const published = await options.project.apply({
          expectedRevision: candidate.changeSet.projectRevision,
          upserts: candidate.resources,
        });
        const result = DefaultAgentProjectCommitSchema.parse({
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
  readonly options: DefaultAgentExpertOptionCatalog;
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
            tags: ["desktop-managed", "default-agent-option"],
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
      description: capabilityDescription(capability),
      kind: capability.definition.kind === "skill" ? ("skill" as const) : ("tools" as const),
      toolNames,
    };
  });
  return {
    options: DefaultAgentExpertOptionCatalogSchema.parse({
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
      description: capabilityDescription(capability),
      tags: ["desktop-managed", "default-agent-option"],
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

function capabilityDescription(capability: Capability): string {
  const description = capability.definition.description.trim();
  return description === ""
    ? `Host-provided Desktop capability ${capability.definition.name}.`
    : description;
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

function parseDefaultAgentResource(source: string): PragmaResource {
  const resource = PragmaResourceSchema.parse(parsePragmaYaml(source));
  if (
    resource.kind !== "Expert" &&
    resource.kind !== "ExpertTeam" &&
    resource.kind !== "Flow" &&
    resource.kind !== "Automation"
  ) {
    throw new Error(
      "default Agent can only create or update Expert, ExpertTeam, Flow, and Automation resources.",
    );
  }
  return resource;
}

function parseDefaultAgentSources(
  sources: readonly string[],
  sourceIndexOffset = 0,
): {
  readonly resources: readonly PragmaResource[];
  readonly diagnostics: ReturnType<typeof diagnosticsFromError>;
} {
  const resources: PragmaResource[] = [];
  const diagnostics: ReturnType<typeof diagnosticsFromError> = [];
  sources.forEach((source, index) => {
    try {
      resources.push(parseDefaultAgentResource(source));
    } catch (error) {
      diagnostics.push(...diagnosticsFromError(error, `source:${sourceIndexOffset + index}`));
    }
  });
  return { resources, diagnostics };
}

function invalidPrepare(code: string, message: string): DefaultAgentPrepareResult {
  return DefaultAgentPrepareResultSchema.parse({
    status: "invalid",
    diagnostics: [{ severity: "error", code, message, path: [] }],
  });
}

function diagnosticsFromError(error: unknown, source?: string) {
  if (error instanceof z.ZodError) {
    return error.issues.map((issue) => ({
      severity: "error" as const,
      code: "schema.invalid",
      message: issue.message,
      ...(source === undefined ? {} : { source }),
      path: issue.path.filter((segment): segment is string | number => typeof segment !== "symbol"),
    }));
  }
  return [
    {
      severity: "error" as const,
      code: "source.parse",
      message: error instanceof Error ? error.message : String(error),
      ...(source === undefined ? {} : { source }),
      path: [],
    },
  ];
}

function materializeDraft(draft: DefaultAgentFlowDraft): PragmaFlowResource {
  return {
    ...draft.resource,
    spec: {
      ...draft.resource.spec,
      graph: {
        ...draft.resource.spec.graph,
        start: draft.resource.spec.graph.start ?? "",
      },
    },
  } as PragmaFlowResource;
}

function withDraftDiagnostics(draft: DefaultAgentFlowDraft): DefaultAgentFlowDraft {
  const parsed = DefaultAgentFlowDraftSchema.parse(draft);
  const resource = materializeDraft(parsed);
  const diagnostics: DefaultAgentFlowDraftDiagnostic[] = [];
  const stepCount = Object.keys(resource.spec.graph.steps).length;
  if (stepCount === 0) {
    diagnostics.push({
      severity: "incomplete",
      code: "flow.draft.steps_missing",
      message: "Add at least one Flow step.",
      path: ["spec", "graph", "steps"],
    });
  }
  if (resource.spec.graph.start === "") {
    diagnostics.push({
      severity: "incomplete",
      code: "flow.draft.start_missing",
      message: "Choose a Flow start step.",
      path: ["spec", "graph", "start"],
    });
  }
  const schema = PragmaFlowResourceSchema.safeParse(resource);
  if (!schema.success) {
    for (const issue of schema.error.issues) {
      const path = issue.path.filter(
        (segment): segment is string | number => typeof segment !== "symbol",
      );
      if (path.join(".") === "spec.graph.start" && resource.spec.graph.start === "") continue;
      diagnostics.push({
        severity: "error",
        code: "schema.invalid",
        message: issue.message,
        path,
      });
    }
  }
  if (stepCount > 0) {
    const graph = analyzePragmaFlowGraph(resource);
    const missingTransition = graph.issues.some((issue) =>
      issue.code.endsWith("transition.missing"),
    );
    for (const issue of graph.issues) {
      if (issue.code.endsWith("start.unknown") && resource.spec.graph.start === "") continue;
      const incomplete =
        issue.code.endsWith("transition.missing") ||
        (missingTransition &&
          (issue.code.endsWith("step.unreachable") || issue.code.endsWith("loop.not_cyclic")));
      diagnostics.push({
        severity: incomplete ? "incomplete" : "error",
        code: issue.code,
        message: issue.message,
        path: [...issue.path],
      });
    }
  }
  const unique = diagnostics.filter(
    (diagnostic, index) =>
      diagnostics.findIndex(
        (candidate) =>
          candidate.code === diagnostic.code &&
          JSON.stringify(candidate.path) === JSON.stringify(diagnostic.path),
      ) === index,
  );
  return DefaultAgentFlowDraftSchema.parse({ ...parsed, diagnostics: unique });
}

function applyDraftOperation(
  resource: DefaultAgentFlowDraft["resource"],
  operation: DefaultAgentFlowDraftOperation,
  baseProjectRevision: number,
): number {
  const graph = resource.spec.graph;
  switch (operation.type) {
    case "set_start":
      graph.start = operation.stepId;
      break;
    case "upsert_step":
      graph.steps[operation.stepId] = operation.step;
      break;
    case "remove_step":
      delete graph.steps[operation.stepId];
      delete graph.transitions[operation.stepId];
      if (graph.start === operation.stepId) delete graph.start;
      break;
    case "set_transition":
      graph.transitions[operation.stepId] = operation.transition;
      break;
    case "remove_transition":
      delete graph.transitions[operation.stepId];
      break;
    case "upsert_loop":
      graph.loops[operation.loopId] = operation.loop;
      break;
    case "remove_loop":
      delete graph.loops[operation.loopId];
      break;
    case "set_contracts":
      if (operation.input === null) delete resource.spec.input;
      else if (operation.input !== undefined) resource.spec.input = operation.input;
      if (operation.output === null) delete resource.spec.output;
      else if (operation.output !== undefined) resource.spec.output = operation.output;
      if (operation.limits !== undefined) resource.spec.limits = operation.limits;
      break;
    case "rebase":
      return operation.projectRevision;
  }
  return baseProjectRevision;
}

async function readFlowDraft(path: string): Promise<DefaultAgentFlowDraft> {
  const value = await readJson(path);
  if (value === undefined) throw new Error("Flow draft not found.");
  return DefaultAgentFlowDraftSchema.parse(value);
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
