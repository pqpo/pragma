import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import {
  defineExpertTeam,
  type Expert,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
} from "@pragma/core";
import { stringify } from "yaml";
import { z } from "zod";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  PragmaBundleSchema,
  PragmaForwardCompatibleBundleSchema,
  PragmaLockSchema,
  type PragmaDiagnostic,
  type PragmaDeclarativeResource,
  type PragmaLock,
  type PragmaResource,
  type PragmaResourceRef,
  type PragmaResourceHealth,
  type PragmaSemanticResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import {
  parsePragmaReference,
  pragmaResourceDirectory,
  pragmaResourceFileName,
} from "../ast/resource-identity.ts";
import {
  ContextPolicyRegistry,
  FlowActionRegistry,
  ToolAdapterRegistry,
  type InvocableResource,
  type PragmaCompileHost,
  type PragmaPluginResolution,
  type ResolvedInvocableResource,
} from "../runtime/registries.ts";
import {
  createDefaultPragmaResourceAdapterRegistry,
  PragmaResourceNeedsAttentionError,
  type PragmaCapabilityContribution,
  type PragmaContextStoreContribution,
  type PragmaResourceContribution,
  type PragmaResourceInspection,
  type PragmaRuntimeProfileContribution,
} from "../runtime/resource-adapters.ts";
import { sha256, stableStringify } from "./compiler-hash.ts";
import { PRAGMA_COMPILER_WRITE_VERSION } from "../ast/compiler-compatibility.ts";
import {
  PRAGMA_BUNDLE_WRITE_VERSION,
  type PragmaBundleManifest,
  type PragmaBundleRequirement,
} from "../ast/pragma-bundle.schema.ts";
import { encodePragmaBundle, PragmaBundleFormatError } from "../bundle/pragma-bundle-codec.ts";
import {
  applyPragmaEnvironmentBindingOverlay,
  mergePragmaBindingContributions,
  type PragmaBundleBindingHost,
  type PragmaBundleRequirementInspection,
  type PragmaEnvironmentBindingOverlay,
} from "../bundle/pragma-bundle-environment.ts";
import {
  type CompiledResource,
  type DumpOptions,
  type DumpedFiles,
  type IndexedResource,
  type LoadPragmaProjectOptions,
  type PragmaBundleBindingResult,
  type PragmaBundleExportResult,
  type PragmaCompileOptions,
  PragmaDslError,
  type PragmaEnvironmentInspection,
  type PragmaLoadedBundle,
  type PragmaPrepareCompileResult,
  type PragmaProject,
  type PragmaProjectBundleExportOptions,
} from "./project-contracts.ts";
import {
  canonicalRef,
  collectLockedDependencies,
  isDeclarativeResource,
  isInvocableResource,
  isPlainExpert,
  resourceDependencies,
  validateResourceCycles,
} from "./project-dependencies.ts";
import {
  bundleBindingSlot,
  collectSelectedBundleArtifacts,
  findBundleBindingSlots,
  portableizeBundleResources,
  requirementLocationKey,
  valueAtPath,
} from "./project-bundle.ts";
import {
  validateExtensionEnvironment,
  validateFlowGraph,
  validatePortableSemantics,
} from "./project-validation.ts";
import {
  assertPluginResolution,
  compileExpert,
  compileFlowResource,
  createAdapterHost,
} from "./project-compile.ts";
import {
  resolveRootModelSelection,
  resolveRootRuntime,
  verifyRuntimeEnvironment,
} from "./project-environment.ts";
import { formatPragmaYaml, parsePragmaYaml } from "./project-yaml.ts";

export const provenance = new WeakMap<object, PragmaProvenance>();

export const PragmaBundleProjectLockIdentitySchema = z
  .object({
    compilerVersion: z.string().min(1),
    projectFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .passthrough();

interface PragmaProvenance {
  readonly project: PragmaProjectImpl;
  readonly root: IndexedResource;
}

export class PragmaProjectImpl implements PragmaProject {
  private validation: Promise<readonly PragmaDiagnostic[]> | undefined;
  private lockValidation: Promise<PragmaDiagnostic[]> | undefined;
  private readonly targetedValidations = new Map<
    PragmaSemanticResourceRef,
    Promise<readonly PragmaDiagnostic[]>
  >();
  bundle: PragmaLoadedBundle | undefined;
  private cleanup: (() => Promise<void>) | undefined;
  private bundleFiles: ReadonlyMap<string, Uint8Array> | undefined;
  private disposed = false;

  constructor(
    readonly entryFile: string,
    readonly rootDir: string,
    private readonly resources: ReadonlyMap<string, IndexedResource>,
    private readonly artifacts: ReadonlyMap<string, string>,
    private readonly sourceDiagnostics: readonly PragmaDiagnostic[],
    private readonly options: LoadPragmaProjectOptions,
  ) {}

  attachBundle(
    bundle: PragmaLoadedBundle,
    files: ReadonlyMap<string, Uint8Array>,
    cleanup: () => Promise<void>,
  ): void {
    this.bundle = bundle;
    this.bundleFiles = files;
    this.cleanup = cleanup;
  }
  async assertBundleManifest(manifest: PragmaBundleManifest): Promise<void> {
    const byRef = new Map(
      [...this.resources.values()].map((indexed) => [
        canonicalRef(indexed.resource),
        indexed.resource,
      ]),
    );
    const fail = (message: string): never => {
      throw new PragmaBundleFormatError("manifest.invalid", message);
    };
    const requirementsById = new Map(
      manifest.requirements.map((requirement) => [requirement.id, requirement]),
    );
    const requirementsByLocation = new Map<string, PragmaBundleRequirement[]>();
    for (const requirement of manifest.requirements) {
      const key = requirementLocationKey(requirement.kind, requirement.ownerRef, requirement.path);
      const matches = requirementsByLocation.get(key) ?? [];
      matches.push(requirement);
      requirementsByLocation.set(key, matches);
    }
    const requirementAt = (
      kind: PragmaBundleRequirement["kind"],
      ownerRef: string,
      path: readonly (string | number)[],
      contract?: string,
    ): PragmaBundleRequirement | undefined =>
      requirementsByLocation
        .get(requirementLocationKey(kind, ownerRef, path))
        ?.find((requirement) => contract === undefined || requirement.contract === contract);
    for (const requirement of manifest.requirements) {
      const resource = byRef.get(requirement.ownerRef);
      if (resource === undefined) {
        throw new PragmaBundleFormatError(
          "manifest.invalid",
          `Bundle requirement owner is missing: ${requirement.ownerRef}.`,
        );
      }
      const value = valueAtPath(resource, requirement.path);
      if (requirement.kind === "binding" || requirement.kind === "secret") {
        if (value !== bundleBindingSlot(requirement.id)) {
          fail(`Bundle binding slot does not match requirement ${requirement.id}.`);
        }
        if (
          requirement.kind === "binding" &&
          (!isDeclarativeResource(resource) ||
            requirement.contract !== resource.spec.adapter ||
            stableStringify(requirement.path) !== stableStringify(["spec", "binding"]))
        ) {
          fail(`Bundle binding contract is invalid: ${requirement.id}.`);
        }
        if (requirement.kind === "secret") {
          const pluginIndex = requirement.path[2];
          const secretName = requirement.path[4];
          const plugin =
            resource.kind === "Expert" &&
            requirement.path[0] === "spec" &&
            requirement.path[1] === "plugins" &&
            typeof pluginIndex === "number" &&
            requirement.path[3] === "secretBindings" &&
            typeof secretName === "string"
              ? resource.spec.plugins[pluginIndex]
              : undefined;
          if (
            plugin === undefined ||
            requirement.path.length !== 5 ||
            requirement.contract !== `${plugin.ref}:secret:${secretName}`
          ) {
            fail(`Bundle secret contract is invalid: ${requirement.id}.`);
          }
        }
      } else if (requirement.kind === "plugin") {
        if (
          typeof value !== "object" ||
          value === null ||
          (value as Record<string, unknown>)["ref"] !== requirement.contract
        ) {
          fail(`Bundle plugin contract does not match requirement ${requirement.id}.`);
        }
      } else if (requirement.kind === "runtime") {
        const runtimeId = requirement.hints["runtimeId"];
        if (
          resource.kind !== "RuntimeProfile" ||
          requirement.contract !== "pragma.runtime@v1" ||
          typeof value !== "string" ||
          value !== runtimeId
        ) {
          fail(`Bundle Runtime contract does not match requirement ${requirement.id}.`);
        }
      } else if (requirement.kind === "external-artifact") {
        if (!isDeclarativeResource(resource)) {
          throw new PragmaBundleFormatError(
            "manifest.invalid",
            `Bundle external artifact owner is invalid: ${requirement.id}.`,
          );
        }
        const adapters =
          this.options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
        const source = adapters
          .artifactSources(resource)
          .find(
            (candidate) =>
              candidate.type !== "project" && candidate.integrity === requirement.contract,
          );
        if (
          source === undefined ||
          source.type === "project" ||
          requirement.hints["uri"] !== source.uri ||
          requirement.hints["integrity"] !== source.integrity
        ) {
          fail(`Bundle external artifact contract is invalid: ${requirement.id}.`);
        }
      }
    }
    for (const [ownerRef, resource] of byRef) {
      for (const slot of findBundleBindingSlots(resource)) {
        const requirement = requirementsById.get(slot.requirementId);
        if (
          requirement === undefined ||
          requirement.ownerRef !== ownerRef ||
          stableStringify(requirement.path) !== stableStringify(slot.path)
        ) {
          fail(`Portable binding slot has no matching requirement: ${slot.value}.`);
        }
      }
      if (resource.kind === "RuntimeProfile") {
        const runtimeId = (resource.spec.config as Record<string, unknown>)["runtimeId"];
        if (
          requirementAt("runtime", ownerRef, ["spec", "config", "runtimeId"])?.hints[
            "runtimeId"
          ] !== runtimeId
        ) {
          fail(`RuntimeProfile requirement is missing or inconsistent: ${ownerRef}.`);
        }
      }
      if (resource.kind === "Expert") {
        for (const [index, plugin] of resource.spec.plugins.entries()) {
          if (
            requirementAt("plugin", ownerRef, ["spec", "plugins", index], plugin.ref) === undefined
          ) {
            fail(`Plugin requirement is missing: ${ownerRef} ${plugin.ref}.`);
          }
        }
      }
      if (isDeclarativeResource(resource)) {
        const adapters =
          this.options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
        for (const source of adapters.artifactSources(resource)) {
          if (source.type === "project") continue;
          if (
            requirementAt("external-artifact", ownerRef, ["spec", "config"], source.integrity) ===
            undefined
          ) {
            fail(`External artifact requirement is missing: ${ownerRef} ${source.uri}.`);
          }
        }
      }
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    await this.cleanup?.();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.dispose();
  }

  listResources(): readonly PragmaResource[] {
    return [...this.resources.values()]
      .map((indexed) => indexed.resource)
      .sort((left, right) => canonicalRef(left).localeCompare(canonicalRef(right)));
  }

  listResourceClosure(ref: PragmaResourceRef): readonly PragmaResource[] {
    return [...this.collectDependencyClosure(this.resolveResource(ref)).values()]
      .map((indexed) => indexed.resource)
      .sort((left, right) => canonicalRef(left).localeCompare(canonicalRef(right)));
  }

  async validate(): Promise<readonly PragmaDiagnostic[]> {
    this.validation ??= this.validateResources(this.resources);
    return await this.validation;
  }

  async validateFor(ref: PragmaResourceRef): Promise<readonly PragmaDiagnostic[]> {
    const root = this.resolveResource(ref);
    const rootRef = canonicalRef(root.resource);
    let validation = this.targetedValidations.get(rootRef);
    if (validation === undefined) {
      validation = this.validateResources(this.collectDependencyClosure(root));
      this.targetedValidations.set(rootRef, validation);
    }
    return await validation;
  }

  private async validateResources(
    resources: ReadonlyMap<string, IndexedResource>,
  ): Promise<readonly PragmaDiagnostic[]> {
    const diagnostics = [...this.sourceDiagnostics];
    const adapters = this.options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry();
    for (const indexed of resources.values()) {
      const resourceRef = canonicalRef(indexed.resource);
      diagnostics.push(...this.validateReferences(indexed));
      diagnostics.push(
        ...validatePortableSemantics(indexed, this.resources).map((diagnostic) => ({
          ...diagnostic,
          resourceRef,
        })),
      );
      if (indexed.resource.kind === "Flow") {
        diagnostics.push(
          ...validateFlowGraph(indexed, this.resources).map((diagnostic) => ({
            ...diagnostic,
            resourceRef,
          })),
        );
      }
      if (isDeclarativeResource(indexed.resource)) {
        diagnostics.push(
          ...adapters.validate(indexed.resource).map((diagnostic) => ({
            ...diagnostic,
            resourceRef,
            source: indexed.source,
          })),
        );
      }
    }
    diagnostics.push(...validateResourceCycles(resources));
    if (this.options.requireLock === true) diagnostics.push(...(await this.validateLock()));
    return diagnostics;
  }

  private collectDependencyClosure(root: IndexedResource): ReadonlyMap<string, IndexedResource> {
    const closure = new Map<string, IndexedResource>();
    const visit = (indexed: IndexedResource): void => {
      const ref = canonicalRef(indexed.resource);
      if (closure.has(ref)) return;
      closure.set(ref, indexed);
      for (const dependencyRef of resourceDependencies(indexed.resource)) {
        const parsed = parsePragmaReference(dependencyRef);
        const dependency = this.resources.get(`${parsed.kind}:${parsed.id}`);
        if (dependency !== undefined) visit(dependency);
      }
    };
    visit(root);
    return closure;
  }

  async validateEnvironment(host: PragmaCompileOptions): Promise<readonly PragmaDiagnostic[]> {
    return (await this.inspectEnvironment(host)).diagnostics;
  }

  async inspectEnvironment(host: PragmaCompileOptions): Promise<PragmaEnvironmentInspection> {
    return await this.inspectEnvironmentResources(this.resources, await this.validate(), host);
  }

  async inspectEnvironmentFor(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<PragmaEnvironmentInspection> {
    const root = this.resolveResource(ref);
    return await this.inspectEnvironmentResources(
      this.collectDependencyClosure(root),
      await this.validateFor(ref),
      host,
    );
  }

  private async inspectEnvironmentResources(
    resources: ReadonlyMap<string, IndexedResource>,
    portableDiagnostics: readonly PragmaDiagnostic[],
    host: PragmaCompileOptions,
  ): Promise<PragmaEnvironmentInspection> {
    host = this.withProjectRoot(host);
    const diagnostics = [...portableDiagnostics];
    if (diagnostics.some((diagnostic) => diagnostic.severity === "error")) {
      return { diagnostics, resources: [] };
    }
    const adapters =
      host.resourceAdapters ??
      this.options.resourceAdapters ??
      createDefaultPragmaResourceAdapterRegistry();
    const adapterHost = createAdapterHost(
      host,
      this.artifacts,
      this.options.sourceIdentity !== undefined,
    );
    diagnostics.push(...validateExtensionEnvironment(resources, host));
    if (host.plugins !== undefined) {
      for (const indexed of resources.values()) {
        if (indexed.resource.kind !== "Expert") continue;
        for (const [index, binding] of indexed.resource.spec.plugins.entries()) {
          try {
            const inspection = await host.plugins.inspect({
              expertRef: canonicalRef(indexed.resource) as `expert:${string}`,
              binding,
            });
            if (inspection.ref !== binding.ref || inspection.status !== "ready") {
              diagnostics.push(
                ...(inspection.issues.length > 0
                  ? inspection.issues.map((issue) => ({
                      ...issue,
                      source: issue.source ?? indexed.source,
                      path: ["spec", "plugins", index, ...issue.path],
                    }))
                  : [
                      {
                        severity: "error" as const,
                        code: "environment.plugin_unavailable",
                        message:
                          inspection.ref === binding.ref
                            ? `Plugin ${binding.ref} needs attention.`
                            : `Plugin resolver returned ${inspection.ref} for ${binding.ref}.`,
                        source: indexed.source,
                        path: ["spec", "plugins", index],
                      },
                    ]),
              );
            }
          } catch (error) {
            diagnostics.push({
              severity: "error",
              code: "environment.plugin_unavailable",
              message: error instanceof Error ? error.message : String(error),
              source: indexed.source,
              path: ["spec", "plugins", index],
            });
          }
        }
      }
    }
    const health: PragmaResourceHealth[] = [];
    for (const indexed of resources.values()) {
      if (!isDeclarativeResource(indexed.resource)) continue;
      const baseInspection = await adapters.inspect(indexed.resource, adapterHost);
      const inspection =
        indexed.resource.kind === "RuntimeProfile"
          ? await verifyRuntimeEnvironment(
              baseInspection as PragmaResourceInspection<PragmaRuntimeProfileContribution>,
              host.runtimes,
              true,
            )
          : baseInspection;
      const resourceHealth = inspection.health;
      health.push(resourceHealth);
      diagnostics.push(
        ...resourceHealth.issues.map((issue) => ({
          ...issue,
          source: issue.source ?? indexed.source,
        })),
      );
    }
    return { diagnostics, resources: health };
  }

  async inspectBundleBindings(
    ref: PragmaResourceRef,
    host: PragmaBundleBindingHost,
  ): Promise<readonly PragmaBundleRequirementInspection[]> {
    const requirements = this.bundleRequirementsFor(ref);
    return await Promise.all(
      requirements.map(async (requirement) => {
        const inspection = await host.inspect({
          requirement,
          payload: this.readRequirementPayload(requirement.id),
        });
        if (inspection.requirementId !== requirement.id) {
          throw new Error(
            `Bundle binding Host returned ${inspection.requirementId} for ${requirement.id}.`,
          );
        }
        return inspection;
      }),
    );
  }

  async bindEnvironment(
    ref: PragmaResourceRef,
    host: PragmaBundleBindingHost,
    selections: Readonly<Record<string, string>> = {},
  ): Promise<PragmaBundleBindingResult> {
    const requirements = this.bundleRequirementsFor(ref);
    const contributions = await Promise.all(
      requirements.map(
        async (requirement) =>
          await host.bind({
            requirement,
            candidateId: selections[requirement.id],
            payload: this.readRequirementPayload(requirement.id),
          }),
      ),
    );
    return {
      overlay: mergePragmaBindingContributions(contributions),
      requirements: await this.inspectBundleBindings(ref, host),
    };
  }

  async prepareCompile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
    overlay?: PragmaEnvironmentBindingOverlay,
  ): Promise<PragmaPrepareCompileResult<T>> {
    const portable = await this.validateFor(ref);
    if (portable.some((diagnostic) => diagnostic.severity === "error")) {
      return { status: "invalid", diagnostics: portable };
    }
    const effectiveHost =
      overlay === undefined ? host : applyPragmaEnvironmentBindingOverlay(host, overlay);
    const environment = await this.inspectEnvironmentFor(ref, effectiveHost);
    const unavailable =
      environment.diagnostics.some((diagnostic) => diagnostic.severity === "error") ||
      environment.resources.some((resource) => resource.status !== "ready");
    if (unavailable) {
      return {
        status: "needs_binding",
        requirements: this.bundleRequirementsFor(ref),
        diagnostics: environment.diagnostics,
        resources: environment.resources,
      };
    }
    try {
      return { status: "ready", compiled: await this.compile<T>(ref, effectiveHost) };
    } catch (error) {
      if (error instanceof PragmaResourceNeedsAttentionError) {
        return {
          status: "needs_binding",
          requirements: this.bundleRequirementsFor(ref),
          diagnostics: error.health.issues,
          resources: [error.health],
        };
      }
      if (error instanceof PragmaDslError) {
        return { status: "invalid", diagnostics: error.diagnostics };
      }
      throw error;
    }
  }

  private bundleRequirementsFor(ref: PragmaResourceRef): readonly PragmaBundleRequirement[] {
    if (this.bundle === undefined) return [];
    const closure = this.collectDependencyClosure(this.resolveResource(ref));
    const refs = new Set([...closure.values()].map((indexed) => canonicalRef(indexed.resource)));
    return this.bundle.manifest.requirements.filter((requirement) =>
      refs.has(requirement.ownerRef),
    );
  }

  private readRequirementPayload(requirementId: string): ReadonlyMap<string, Uint8Array> {
    const requirement = this.bundle?.manifest.requirements.find(
      (item) => item.id === requirementId,
    );
    if (requirement?.payload === undefined || this.bundleFiles === undefined) return new Map();
    const root = `${requirement.payload.root}/`;
    return new Map(
      [...this.bundleFiles]
        .filter(([path]) => path.startsWith(root))
        .map(([path, contents]) => [path.slice(root.length), contents] as const),
    );
  }

  private withProjectRoot(host: PragmaCompileHost): PragmaCompileHost {
    return {
      ...host,
      projectRoot: this.bundle === undefined ? (host.projectRoot ?? this.rootDir) : this.rootDir,
    };
  }

  async compile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<CompiledResource<T>> {
    host = this.withProjectRoot(host);
    const compilerErrors = this.sourceDiagnostics.filter(
      (diagnostic) => diagnostic.severity === "error" && diagnostic.code.startsWith("compiler."),
    );
    if (compilerErrors.length > 0) {
      throw new PragmaDslError(
        `Pragma project compiler compatibility check failed: ${compilerErrors
          .map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`)
          .join("; ")}`,
        compilerErrors,
      );
    }
    const indexed = this.resolveResource(ref);
    if (!isInvocableResource(indexed.resource)) {
      throw new PragmaDslError(`Resource is not invocable: ${ref}`);
    }
    const diagnostics = await this.validateFor(ref);
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) {
      throw new PragmaDslError(
        `Pragma project validation failed: ${errors.map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`).join("; ")}`,
        errors,
      );
    }
    const cache = new Map<string, ResolvedInvocableResource>();
    const compiling = new Set<string>();
    const contextPolicies = host.contextPolicies ?? new ContextPolicyRegistry();
    const actions = host.actions ?? new FlowActionRegistry();
    const toolAdapters = host.toolAdapters ?? new ToolAdapterRegistry();
    const resourceAdapters =
      host.resourceAdapters ??
      this.options.resourceAdapters ??
      createDefaultPragmaResourceAdapterRegistry();
    const adapterHost = createAdapterHost(
      host,
      this.artifacts,
      this.options.sourceIdentity !== undefined,
    );
    const resolvedResources = new Map<
      string,
      { readonly contribution: PragmaResourceContribution; readonly health: PragmaResourceHealth }
    >();
    const resolvingResources = new Map<
      string,
      Promise<{
        readonly contribution: PragmaResourceContribution;
        readonly health: PragmaResourceHealth;
      }>
    >();
    const resolvedPlugins: {
      readonly expertRef: string;
      readonly ref: string;
      readonly resolution: PragmaPluginResolution;
    }[] = [];
    const resolvingPlugins = new Map<string, Promise<PragmaPluginResolution>>();

    const resolveDeclarative = async <TContribution extends PragmaResourceContribution>(
      resourceRef: string,
      kind: PragmaDeclarativeResource["kind"],
    ): Promise<{ readonly contribution: TContribution; readonly health: PragmaResourceHealth }> => {
      const indexed = this.resolveResource(resourceRef);
      if (indexed.resource.kind !== kind) {
        throw new PragmaDslError(`Expected ${kind} resource, received: ${resourceRef}`);
      }
      const key = canonicalRef(indexed.resource);
      const existing = resolvedResources.get(key);
      if (existing !== undefined) {
        return existing as {
          readonly contribution: TContribution;
          readonly health: PragmaResourceHealth;
        };
      }
      const pending = resolvingResources.get(key);
      if (pending !== undefined) {
        return (await pending) as {
          readonly contribution: TContribution;
          readonly health: PragmaResourceHealth;
        };
      }
      const resolving = (async () => {
        const baseResolved = await resourceAdapters.resolve<TContribution>(
          indexed.resource as PragmaDeclarativeResource,
          adapterHost,
        );
        const resolved =
          indexed.resource.kind === "RuntimeProfile" && host.runtimes !== undefined
            ? await verifyRuntimeEnvironment(
                baseResolved as PragmaResourceInspection<PragmaRuntimeProfileContribution>,
                host.runtimes,
                false,
              )
            : baseResolved;
        if (resolved.health.status !== "ready" || resolved.contribution === undefined) {
          throw new PragmaResourceNeedsAttentionError(resolved.health);
        }
        const value = {
          contribution: resolved.contribution,
          health: resolved.health,
        };
        resolvedResources.set(key, value);
        return value;
      })();
      resolvingResources.set(key, resolving);
      try {
        return (await resolving) as {
          readonly contribution: TContribution;
          readonly health: PragmaResourceHealth;
        };
      } finally {
        if (resolvingResources.get(key) === resolving) resolvingResources.delete(key);
      }
    };

    const resolveRuntime = async (runtimeRef: string): Promise<PragmaRuntimeProfileContribution> =>
      (await resolveDeclarative<PragmaRuntimeProfileContribution>(runtimeRef, "RuntimeProfile"))
        .contribution;

    const rootExpertRefs = new Set<string>();
    if (indexed.resource.kind === "Expert") {
      rootExpertRefs.add(canonicalRef(indexed.resource));
    } else if (indexed.resource.kind === "ExpertTeam") {
      rootExpertRefs.add(indexed.resource.spec.coordinator.ref);
    }

    const instantiate = async (resourceRef: string): Promise<ResolvedInvocableResource> => {
      const parsedRef = parsePragmaReference(resourceRef);
      const externalKey = `${parsedRef.kind}:${parsedRef.id}` as PragmaResourceRef;
      const indexed = this.resources.get(externalKey);
      if (indexed === undefined) {
        const existing = cache.get(externalKey);
        if (existing !== undefined) return existing;
        const external = await host.resolveExternalInvocable?.(externalKey);
        if (external === undefined) {
          throw new PragmaDslError(`Pragma resource not found: ${resourceRef}`);
        }
        cache.set(externalKey, external);
        return external;
      }
      const key = canonicalRef(indexed.resource);
      const existing = cache.get(key);
      if (existing !== undefined) return existing;
      if (compiling.has(key)) throw new PragmaDslError(`Cyclic resource dependency: ${key}`);
      compiling.add(key);
      let value: InvocableResource;
      if (indexed.resource.kind === "Expert") {
        const tools: ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[] = [];
        for (const binding of indexed.resource.spec.tools) {
          const targetRefs = binding.target === undefined ? binding.targets! : [binding.target];
          const targets = await Promise.all(
            targetRefs.map(async (target) => await instantiate(target.ref)),
          );
          const runtimeEntries = await Promise.all(
            Object.entries(binding.policy?.runtimes ?? {}).map(
              async ([expertId, runtimeRef]) =>
                [expertId, (await resolveRuntime(runtimeRef)).runtimeId] as const,
            ),
          );
          tools.push(
            ...toolAdapters.createTools({
              binding,
              targets,
              contextPolicies,
              runtimeByExpert: Object.fromEntries(runtimeEntries),
            }),
          );
        }
        value = await compileExpert(
          indexed.resource,
          tools,
          host,
          rootExpertRefs.has(key) ? host.rootExecutionOverride : undefined,
          {
            resolveCapability: async (resourceRef) =>
              (await resolveDeclarative<PragmaCapabilityContribution>(resourceRef, "Capability"))
                .contribution,
            resolveContextStore: async (resourceRef) =>
              (
                await resolveDeclarative<PragmaContextStoreContribution>(
                  resourceRef,
                  "ContextStore",
                )
              ).contribution,
            resolveRuntime,
            resolvePlugin: async (binding) => {
              if (host.plugins === undefined) {
                throw new PragmaDslError(
                  `Expert ${indexed.resource.metadata.id} references ${binding.ref}, but the host has no Plugin resolver.`,
                );
              }
              const expertRef = canonicalRef(indexed.resource) as `expert:${string}`;
              const resolutionKey = stableStringify({ expertRef, binding });
              let resolving = resolvingPlugins.get(resolutionKey);
              if (resolving === undefined) {
                resolving = host.plugins.resolve({ expertRef, binding }).then((resolution) => {
                  assertPluginResolution(binding.ref, resolution);
                  resolvedPlugins.push({
                    expertRef,
                    ref: binding.ref,
                    resolution,
                  });
                  return resolution;
                });
                resolvingPlugins.set(resolutionKey, resolving);
              }
              return await resolving;
            },
          },
        );
      } else if (indexed.resource.kind === "ExpertTeam") {
        const coordinator = (await instantiate(indexed.resource.spec.coordinator.ref)).value;
        const members = await Promise.all(
          indexed.resource.spec.members.map(
            async (member) => (await instantiate(member.ref)).value,
          ),
        );
        if (!isPlainExpert(coordinator) || members.some((member) => !isPlainExpert(member))) {
          throw new PragmaDslError(
            `ExpertTeam ${indexed.resource.metadata.id} only accepts Experts.`,
          );
        }
        const runtimeEntries = await Promise.all(
          Object.entries(indexed.resource.spec.delegation.runtimes).map(
            async ([expertId, runtimeRef]) =>
              [expertId, (await resolveRuntime(runtimeRef)).runtimeId] as const,
          ),
        );
        const contextStores = await Promise.all(
          indexed.resource.spec.contextStores.map(async (binding) => {
            const contribution = (
              await resolveDeclarative<PragmaContextStoreContribution>(binding.ref, "ContextStore")
            ).contribution;
            return {
              namespace: binding.namespace,
              required: binding.required,
              visibility: binding.visibility,
              store: contribution.store,
              ...(contribution.storeName === undefined
                ? {}
                : { storeName: contribution.storeName }),
            };
          }),
        );
        value = defineExpertTeam({
          id: indexed.resource.metadata.id,
          name: indexed.resource.metadata.name,
          description: indexed.resource.metadata.description,
          instructions: indexed.resource.spec.instructions,
          coordinator,
          members: members as Expert[],
          contextStores,
          delegation: {
            permissions: indexed.resource.spec.delegation.permissions,
            maxConcurrency: indexed.resource.spec.delegation.maxConcurrency,
            maxDepth: indexed.resource.spec.delegation.maxDepth,
            runtimeByExpert: Object.fromEntries(runtimeEntries),
          },
        });
      } else if (indexed.resource.kind === "Flow") {
        value = await compileFlowResource(
          indexed.resource,
          async (targetRef) => (await instantiate(targetRef)).value,
          actions,
          contextPolicies,
          resolveRuntime,
        );
      } else {
        throw new PragmaDslError(`Resource is not invocable: ${resourceRef}`);
      }
      compiling.delete(key);
      const resolved = { resource: indexed.resource, value } satisfies ResolvedInvocableResource;
      cache.set(key, resolved);
      provenance.set(value, { project: this, root: indexed });
      return resolved;
    };

    const value = (await instantiate(ref)).value as T;
    const rootRuntimeId = await resolveRootRuntime(
      indexed.resource,
      this.resources,
      resolveRuntime,
      host,
    );
    let rootRuntimeEnvironment: unknown;
    if (host.runtimes !== undefined) {
      const rootModelSelection = await resolveRootModelSelection(
        indexed.resource,
        this.resources,
        resolveRuntime,
        host,
      );
      const resolvedRootRuntime = await host.runtimes.bind({
        runtimeId: rootRuntimeId,
        ...(rootModelSelection === undefined ? {} : { modelSelection: rootModelSelection }),
      });
      const availability = await resolvedRootRuntime.adapter.canUse();
      if (!availability.usable) {
        throw new Error(
          availability.reason ??
            `Runtime is unavailable: ${resolvedRootRuntime.adapter.descriptor.id}`,
        );
      }
      const models =
        resolvedRootRuntime.adapter.listModels === undefined
          ? undefined
          : await resolvedRootRuntime.adapter.listModels();
      rootRuntimeEnvironment = {
        binding: resolvedRootRuntime.binding,
        descriptor: resolvedRootRuntime.adapter.descriptor,
        availability,
        models,
        ...(rootModelSelection === undefined ? {} : { modelSelection: rootModelSelection }),
      };
    }
    const projectFingerprint = this.createLock().projectFingerprint;
    const fingerprintResources = [...resolvedResources.entries()]
      .map(([resourceRef, resolved]) => ({
        ref: resourceRef as PragmaSemanticResourceRef,
        ...(resolved.health.bindingRevision === undefined
          ? {}
          : { bindingRevision: resolved.health.bindingRevision }),
        verificationFingerprint: resolved.health.verificationFingerprint!,
      }))
      .sort((left, right) => left.ref.localeCompare(right.ref));
    const fingerprintPlugins = resolvedPlugins
      .map((resolved) => ({
        expertRef: resolved.expertRef,
        ref: resolved.ref,
        packageFingerprint: resolved.resolution.packageFingerprint,
        verificationFingerprint: resolved.resolution.verificationFingerprint,
      }))
      .sort((left, right) =>
        `${left.expertRef}:${left.ref}`.localeCompare(`${right.expertRef}:${right.ref}`),
      );
    const environmentFingerprintValue = sha256(
      stableStringify({
        environmentId: adapterHost.environmentId,
        projectFingerprint,
        resources: fingerprintResources,
        plugins: fingerprintPlugins,
        rootRuntime: rootRuntimeEnvironment,
      }),
    );
    return {
      ref: canonicalRef(indexed.resource),
      value,
      fingerprint: indexed.contentHash,
      projectFingerprint,
      environmentFingerprint: {
        environmentId: adapterHost.environmentId,
        projectFingerprint,
        value: environmentFingerprintValue,
        resources: fingerprintResources,
        plugins: fingerprintPlugins,
      },
      ...(rootRuntimeId === undefined ? {} : { rootRuntimeId }),
      dependencies: collectLockedDependencies(indexed, this.resources),
    };
  }

  async dump(resource: object, options: DumpOptions = {}): Promise<DumpedFiles> {
    const source = provenance.get(resource);
    if (source === undefined) {
      const serialized = this.options.serializers?.serialize(resource);
      if (serialized === undefined) {
        throw new PragmaDslError(
          "Cannot dump a programmatic resource because one or more components have no descriptor.",
        );
      }
      return { files: new Map([[`${serialized.metadata.id}.pragma.yaml`, stringify(serialized)]]) };
    }
    const mode = options.split ?? "preserve";
    if (mode === "single") {
      const bundle = PragmaForwardCompatibleBundleSchema.parse({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Bundle",
        resources: this.listResources(),
      });
      return { files: new Map([["pragma.yaml", stringify(bundle)]]) };
    }
    const files = new Map<string, string>();
    const imports: string[] = [];
    for (const indexed of this.resources.values()) {
      const path = `${pragmaResourceDirectory(indexed.resource)}/${pragmaResourceFileName(indexed.resource)}`;
      imports.push(`./${path}`);
      files.set(path, stringify(indexed.resource));
    }
    files.set(
      "pragma.yaml",
      stringify({
        apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
        kind: "Bundle",
        imports: imports.sort(),
        resources: [],
      }),
    );
    files.set("pragma.lock.yaml", stringify(this.createLock()));
    return { files };
  }

  async exportBundle(options: PragmaProjectBundleExportOptions): Promise<PragmaBundleExportResult> {
    if (options.roots.length === 0)
      throw new PragmaDslError("A bundle requires at least one root.");
    const roots = options.roots.map((root) => {
      if (typeof root === "string") return this.resolveResource(root);
      const source = provenance.get(root);
      if (source?.project === this) return source.root;
      const serialized = this.options.serializers?.serialize(root);
      if (serialized !== undefined) return this.resolveResource(canonicalRef(serialized));
      throw new PragmaDslError("Bundle root has no DSL provenance or registered serializer.");
    });
    const additionalRoots = (options.additionalRoots ?? []).map((root) => {
      if (typeof root === "string") return this.resolveResource(root);
      const source = provenance.get(root);
      if (source?.project === this) return source.root;
      const serialized = this.options.serializers?.serialize(root);
      if (serialized !== undefined) return this.resolveResource(canonicalRef(serialized));
      throw new PragmaDslError("Additional bundle root has no DSL provenance or serializer.");
    });
    const selected = new Map<string, IndexedResource>();
    for (const root of [...roots, ...additionalRoots]) {
      for (const [ref, indexed] of this.collectDependencyClosure(root)) selected.set(ref, indexed);
    }
    const portable = portableizeBundleResources(selected, this.options.resourceAdapters);
    const files = new Map<string, Uint8Array>();
    const resourcePaths = portable.resources
      .map((resource) => {
        const path = `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`;
        files.set(`project/${path}`, new TextEncoder().encode(formatPragmaYaml(resource)));
        return path;
      })
      .toSorted();
    const projectBundle = {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Bundle" as const,
      imports: resourcePaths.map((path) => `./${path}`),
    };
    PragmaBundleSchema.parse(projectBundle);
    files.set("project/pragma.yaml", new TextEncoder().encode(formatPragmaYaml(projectBundle)));

    const generatedProjectPaths = new Set(files.keys());
    generatedProjectPaths.add("project/pragma.lock.yaml");
    const artifacts = await collectSelectedBundleArtifacts(
      portable.resources,
      this.rootDir,
      this.options.resourceAdapters ?? createDefaultPragmaResourceAdapterRegistry(),
      files,
      generatedProjectPaths,
    );
    const lockResources = portable.resources
      .map((resource) => ({
        ref: canonicalRef(resource),
        contentHash: sha256(stableStringify(resource)),
        source: `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`,
      }))
      .toSorted((left, right) => left.ref.localeCompare(right.ref));
    const projectFingerprint = sha256(
      stableStringify({
        resources: lockResources.map(({ ref, contentHash }) => ({ ref, contentHash })),
        artifacts,
      }),
    );
    const lock = PragmaLockSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Lock",
      compilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
      projectFingerprint,
      resources: lockResources,
      artifacts,
    });
    files.set("project/pragma.lock.yaml", new TextEncoder().encode(formatPragmaYaml(lock)));

    const requirements: PragmaBundleRequirement[] = [];
    for (const draft of portable.requirements) {
      const payload =
        draft.requirement.kind === "secret"
          ? undefined
          : await options.host?.exportPayload?.({
              requirement: draft.requirement,
              ...(draft.originalBindingRef === undefined
                ? {}
                : { originalBindingRef: draft.originalBindingRef }),
            });
      if (payload === undefined) {
        requirements.push(draft.requirement);
        continue;
      }
      if (payload.files.size === 0) {
        throw new PragmaDslError(`Bundle payload is empty: ${draft.requirement.id}.`);
      }
      const root = `assets/${draft.requirement.id}`;
      const payloadEntries: { path: string; sha256: string }[] = [];
      for (const [relativePath, contents] of payload.files) {
        const path = `${root}/${relativePath}`;
        files.set(path, contents);
        payloadEntries.push({ path: relativePath, sha256: sha256(contents) });
      }
      requirements.push({
        ...draft.requirement,
        payload: {
          codec: payload.codec,
          root,
          fingerprint: sha256(
            stableStringify(payloadEntries.toSorted((a, b) => a.path.localeCompare(b.path))),
          ),
        },
      });
    }

    const extensions = (options.extensions ?? []).map((extension) => {
      if (extension.files.size === 0) {
        throw new PragmaDslError(
          `Bundle extension is empty: ${extension.id}@${extension.version}.`,
        );
      }
      const root = `extensions/${sha256(`${extension.id}@${extension.version}`).slice(0, 24)}`;
      const entries: { path: string; sha256: string }[] = [];
      for (const [relativePath, contents] of extension.files) {
        files.set(`${root}/${relativePath}`, contents);
        entries.push({ path: relativePath, sha256: sha256(contents) });
      }
      return {
        id: extension.id,
        version: extension.version,
        required: extension.required ?? false,
        root,
        fingerprint: sha256(
          stableStringify(entries.toSorted((a, b) => a.path.localeCompare(b.path))),
        ),
      };
    });
    return await encodePragmaBundle({
      manifest: {
        schemaVersion: PRAGMA_BUNDLE_WRITE_VERSION,
        createdAt: options.createdAt ?? new Date().toISOString(),
        roots: roots.map((root) => canonicalRef(root.resource)),
        project: {
          entry: "project/pragma.yaml",
          compilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
          projectFingerprint,
        },
        requirements,
        extensions,
      },
      files,
    });
  }

  createLock(): PragmaLock {
    const resources = [...this.resources.values()]
      .sort((left, right) =>
        canonicalRef(left.resource).localeCompare(canonicalRef(right.resource)),
      )
      .map((indexed) => ({
        ref: canonicalRef(indexed.resource),
        contentHash: indexed.contentHash,
        source: relative(dirname(this.entryFile), indexed.source),
      }));
    const artifacts = [...this.artifacts.entries()]
      .map(([source, contentHash]) => ({ source, contentHash }))
      .toSorted((left, right) => left.source.localeCompare(right.source));
    return {
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Lock",
      compilerVersion: PRAGMA_COMPILER_WRITE_VERSION,
      projectFingerprint: sha256(
        stableStringify({
          resources: resources.map(({ ref, contentHash }) => ({ ref, contentHash })),
          artifacts,
        }),
      ),
      resources,
      artifacts,
    };
  }

  async readLock(): Promise<PragmaLock> {
    return PragmaLockSchema.parse(
      parsePragmaYaml(await readFile(resolve(dirname(this.entryFile), "pragma.lock.yaml"), "utf8")),
    );
  }

  private async validateLock(): Promise<PragmaDiagnostic[]> {
    this.lockValidation ??= this.validateLockOnce();
    return await this.lockValidation;
  }

  private async validateLockOnce(): Promise<PragmaDiagnostic[]> {
    const lockPath = resolve(dirname(this.entryFile), "pragma.lock.yaml");
    let lock: PragmaLock;
    try {
      lock = PragmaLockSchema.parse(parsePragmaYaml(await readFile(lockPath, "utf8")));
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      return [
        {
          severity: "error",
          code: missing ? "lock.missing" : "lock.invalid",
          message: missing
            ? "Published Pragma project revision is missing pragma.lock.yaml."
            : error instanceof Error
              ? error.message
              : String(error),
          source: lockPath,
          path: [],
        },
      ];
    }
    const expected = this.createLock();
    const expectedByRef = new Map(expected.resources.map((resource) => [resource.ref, resource]));
    const actualByRef = new Map(lock.resources.map((resource) => [resource.ref, resource]));
    const mismatches = [...new Set([...expectedByRef.keys(), ...actualByRef.keys()])].filter(
      (ref) => {
        const left = expectedByRef.get(ref);
        const right = actualByRef.get(ref);
        return left === undefined || right === undefined || left.contentHash !== right.contentHash;
      },
    );
    if (lock.projectFingerprint !== expected.projectFingerprint) {
      mismatches.push(`project:${lock.projectFingerprint}`);
    }
    return mismatches.length === 0
      ? []
      : [
          {
            severity: "error",
            code: "lock.mismatch",
            message: `Pragma lock is stale for: ${mismatches.sort().join(", ")}.`,
            source: lockPath,
            path: ["resources"],
          },
        ];
  }

  private resolveResource(ref: string): IndexedResource {
    const parsed = parsePragmaReference(ref);
    const indexed = this.resources.get(`${parsed.kind}:${parsed.id}`);
    if (indexed === undefined) throw new PragmaDslError(`Pragma resource not found: ${ref}`);
    return indexed;
  }

  private validateReferences(indexed: IndexedResource): PragmaDiagnostic[] {
    const diagnostics: PragmaDiagnostic[] = [];
    const resourceRef = canonicalRef(indexed.resource);
    for (const ref of resourceDependencies(indexed.resource)) {
      if (this.options.externalResourceRefs?.has(ref)) continue;
      try {
        this.resolveResource(ref);
      } catch (error) {
        diagnostics.push({
          severity: "error",
          code: "reference.invalid",
          message: error instanceof Error ? error.message : String(error),
          resourceRef,
          source: indexed.source,
          path: [],
        });
      }
    }
    return diagnostics;
  }
}
