import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import { Validator, type Schema } from "@cfworker/json-schema";
import {
  defineExpert,
  defineExpertTeam,
  defineFlow,
  type Expert,
  type ExpertAgentManagedTool,
  type ExpertAgentToolCallResult,
  type ExpertDefinition,
  type Flow,
  type FlowState,
  type FlowStepReference,
  type FlowTerminal,
} from "@pragma/core";
import { parseDocument, stringify } from "yaml";
import { z } from "zod";

import {
  PragmaBundleSchema,
  PragmaDiagnosticSchema,
  PragmaLockSchema,
  PragmaResourceSchema,
  type PragmaDiagnostic,
  type PragmaExpertResource,
  type PragmaFlowDestination,
  type PragmaFlowResource,
  type PragmaFlowTarget,
  type PragmaFlowTransition,
  type PragmaLock,
  type PragmaResource,
  type PragmaResourceRef,
} from "../ast/pragma-dsl.schema.ts";
import {
  ContextPolicyRegistry,
  DefinitionSerializerRegistry,
  FlowActionRegistry,
  ToolAdapterRegistry,
  parseNamespacedReference,
  type InvocableResource,
  type PragmaCompileHost,
} from "../runtime/registries.ts";

const COMPILER_VERSION = "pragma.dsl/v1";
const provenance = new WeakMap<object, PragmaProvenance>();

export interface LoadPragmaProjectOptions {
  readonly rootDir?: string | undefined;
  readonly requireLock?: boolean | undefined;
  readonly serializers?: DefinitionSerializerRegistry | undefined;
}

export type PragmaCompileOptions = PragmaCompileHost;

export interface CompiledResource<T> {
  readonly ref: PragmaResourceRef;
  readonly value: T;
  readonly fingerprint: string;
  readonly dependencies: readonly LockedResourceRef[];
}

export interface LockedResourceRef {
  readonly ref: PragmaResourceRef;
  readonly version: string;
  readonly contentHash: string;
  readonly source: string;
}

export interface DumpOptions {
  readonly split?: "single" | "preserve" | "by-resource" | undefined;
}

export interface DumpedFiles {
  readonly files: ReadonlyMap<string, string>;
}

export interface PragmaProject {
  readonly entryFile: string;
  listResources(): readonly PragmaResource[];
  validate(): Promise<readonly PragmaDiagnostic[]>;
  compile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<CompiledResource<T>>;
  dump(resource: object, options?: DumpOptions): Promise<DumpedFiles>;
  createLock(): PragmaLock;
}

export class PragmaDslError extends Error {
  constructor(
    message: string,
    readonly diagnostics: readonly PragmaDiagnostic[] = [],
  ) {
    super(message);
    this.name = "PragmaDslError";
  }
}

interface IndexedResource {
  readonly resource: PragmaResource;
  readonly source: string;
  readonly normalized: string;
  readonly contentHash: string;
}

interface PragmaProvenance {
  readonly project: PragmaProjectImpl;
  readonly root: IndexedResource;
}

export async function loadPragmaProject(
  entryFile: string,
  options: LoadPragmaProjectOptions = {},
): Promise<PragmaProject> {
  const absoluteEntry = resolve(entryFile);
  const configuredRoot = resolve(options.rootDir ?? dirname(absoluteEntry));
  const rootDir = await realpath(configuredRoot);
  const loader = new SourceLoader(rootDir);
  await loader.loadEntry(absoluteEntry);
  return new PragmaProjectImpl(absoluteEntry, loader.resources, loader.diagnostics, options);
}

export async function dumpPragmaResource(
  resource: object,
  options: DumpOptions = {},
): Promise<DumpedFiles> {
  const source = provenance.get(resource);
  if (source === undefined) {
    throw new PragmaDslError(
      "Cannot dump a resource without DSL provenance. Register a serializer for programmatic definitions.",
    );
  }
  return await source.project.dump(resource, options);
}

export function formatPragmaYaml(value: unknown): string {
  return stringify(value, { lineWidth: 100 });
}

export function parsePragmaYaml(source: string): unknown {
  const document = parseDocument(source, { prettyErrors: true });
  if (document.errors.length > 0) {
    throw new PragmaDslError(document.errors.map((error) => error.message).join("\n"));
  }
  return document.toJS({ maxAliasCount: 50 });
}

class SourceLoader {
  readonly resources = new Map<string, IndexedResource>();
  readonly diagnostics: PragmaDiagnostic[] = [];
  private readonly loaded = new Set<string>();

  constructor(private readonly rootDir: string) {}

  async loadEntry(path: string): Promise<void> {
    await this.loadFile(path, true);
  }

  private async loadFile(path: string, allowBundle: boolean): Promise<void> {
    let canonical: string;
    try {
      canonical = await this.assertProjectPath(path);
    } catch (error) {
      this.error("source.path", error instanceof Error ? error.message : String(error), path);
      return;
    }
    if (this.loaded.has(canonical)) return;
    this.loaded.add(canonical);

    let raw: unknown;
    try {
      raw = await this.parseYaml(canonical);
      raw = await this.expandIncludes(raw, dirname(canonical), new Set([canonical]));
    } catch (error) {
      this.error("source.parse", error instanceof Error ? error.message : String(error), canonical);
      return;
    }

    const bundle = PragmaBundleSchema.safeParse(raw);
    if (bundle.success) {
      if (!allowBundle) {
        this.error("source.bundle", "A Bundle cannot be used as a structural include.", canonical);
        return;
      }
      for (const imported of bundle.data.imports) {
        await this.loadFile(resolve(dirname(canonical), imported), true);
      }
      for (const resource of bundle.data.resources) this.addResource(resource, canonical);
      return;
    }

    const parsed = PragmaResourceSchema.safeParse(raw);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        this.diagnostics.push(
          PragmaDiagnosticSchema.parse({
            severity: "error",
            code: "schema.invalid",
            message: issue.message,
            source: canonical,
            path: issue.path,
          }),
        );
      }
      return;
    }
    this.addResource(parsed.data, canonical);
  }

  private addResource(resource: PragmaResource, source: string): void {
    const key = resourceKey(resource);
    if (this.resources.has(key)) {
      this.error("resource.duplicate", `Duplicate Pragma resource: ${key}`, source);
      return;
    }
    const normalized = stableStringify(resource);
    this.resources.set(key, {
      resource,
      source,
      normalized,
      contentHash: sha256(normalized),
    });
  }

  private async parseYaml(path: string): Promise<unknown> {
    const source = await readFile(path, "utf8");
    const document = parseDocument(source, { prettyErrors: true });
    if (document.errors.length > 0) {
      throw new Error(document.errors.map((error) => error.message).join("\n"));
    }
    return document.toJS({ maxAliasCount: 50 });
  }

  private async expandIncludes(
    value: unknown,
    baseDir: string,
    stack: Set<string>,
  ): Promise<unknown> {
    if (Array.isArray(value)) {
      return await Promise.all(value.map((entry) => this.expandIncludes(entry, baseDir, stack)));
    }
    if (typeof value !== "object" || value === null) return value;
    const record = value as Record<string, unknown>;
    if (Object.keys(record).length === 1 && typeof record["$include"] === "string") {
      const includedPath = await this.assertProjectPath(resolve(baseDir, record["$include"]));
      if (stack.has(includedPath)) throw new Error(`Cyclic $include: ${includedPath}`);
      const nextStack = new Set(stack).add(includedPath);
      const included = await this.parseYaml(includedPath);
      return await this.expandIncludes(included, dirname(includedPath), nextStack);
    }
    return Object.fromEntries(
      await Promise.all(
        Object.entries(record).map(async ([key, entry]) => [
          key,
          await this.expandIncludes(entry, baseDir, stack),
        ]),
      ),
    );
  }

  private async assertProjectPath(path: string): Promise<string> {
    const canonical = await realpath(path);
    const child = relative(this.rootDir, canonical);
    if (child === "" || (!child.startsWith("..") && !isAbsolute(child))) return canonical;
    throw new Error(`Pragma source escapes the project root: ${path}`);
  }

  private error(code: string, message: string, source?: string): void {
    this.diagnostics.push(
      PragmaDiagnosticSchema.parse({ severity: "error", code, message, source, path: [] }),
    );
  }
}

class PragmaProjectImpl implements PragmaProject {
  constructor(
    readonly entryFile: string,
    private readonly resources: ReadonlyMap<string, IndexedResource>,
    private readonly sourceDiagnostics: readonly PragmaDiagnostic[],
    private readonly options: LoadPragmaProjectOptions,
  ) {}

  listResources(): readonly PragmaResource[] {
    return [...this.resources.values()]
      .map((indexed) => indexed.resource)
      .sort((left, right) => canonicalRef(left).localeCompare(canonicalRef(right)));
  }

  async validate(): Promise<readonly PragmaDiagnostic[]> {
    const diagnostics = [...this.sourceDiagnostics];
    for (const indexed of this.resources.values()) {
      diagnostics.push(...this.validateReferences(indexed));
      if (indexed.resource.kind === "Flow") diagnostics.push(...validateFlowGraph(indexed));
    }
    diagnostics.push(...validateResourceCycles(this.resources));
    if (this.options.requireLock === true) diagnostics.push(...(await this.validateLock()));
    return diagnostics;
  }

  async compile<T extends InvocableResource>(
    ref: PragmaResourceRef,
    host: PragmaCompileOptions,
  ): Promise<CompiledResource<T>> {
    const diagnostics = await this.validate();
    const errors = diagnostics.filter((diagnostic) => diagnostic.severity === "error");
    if (errors.length > 0) throw new PragmaDslError("Pragma project validation failed.", errors);
    const cache = new Map<string, InvocableResource>();
    const compiling = new Set<string>();
    const contextPolicies = host.contextPolicies ?? new ContextPolicyRegistry();
    const actions = host.actions ?? new FlowActionRegistry();
    const toolAdapters = host.toolAdapters ?? new ToolAdapterRegistry();

    const instantiate = async (resourceRef: string): Promise<InvocableResource> => {
      const indexed = this.resolveResource(resourceRef);
      const key = resourceKey(indexed.resource);
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
          tools.push(...toolAdapters.createTools({ binding, targets, contextPolicies }));
        }
        value = await compileExpert(indexed.resource, tools, host);
      } else if (indexed.resource.kind === "ExpertTeam") {
        const coordinator = await instantiate(indexed.resource.spec.coordinator.ref);
        const members = await Promise.all(
          indexed.resource.spec.members.map(async (member) => await instantiate(member.ref)),
        );
        if (!isPlainExpert(coordinator) || members.some((member) => !isPlainExpert(member))) {
          throw new PragmaDslError(
            `ExpertTeam ${indexed.resource.metadata.id} only accepts Experts.`,
          );
        }
        value = defineExpertTeam({
          id: indexed.resource.metadata.id,
          version: indexed.resource.metadata.version,
          name: indexed.resource.metadata.name,
          description: indexed.resource.metadata.description,
          coordinator,
          members: members as Expert[],
          delegation: {
            allow: indexed.resource.spec.delegation.allow,
            maxConcurrency: indexed.resource.spec.delegation.maxConcurrency,
            maxDepth: indexed.resource.spec.delegation.maxDepth,
            contextId: contextPolicies.resolve(indexed.resource.spec.delegation.context),
            runtimeByExpert: indexed.resource.spec.delegation.runtimes,
          },
        });
      } else {
        value = await compileFlowResource(indexed.resource, instantiate, actions, contextPolicies);
      }
      compiling.delete(key);
      cache.set(key, value);
      provenance.set(value, { project: this, root: indexed });
      return value;
    };

    const indexed = this.resolveResource(ref);
    const value = (await instantiate(ref)) as T;
    return {
      ref: canonicalRef(indexed.resource),
      value,
      fingerprint: indexed.contentHash,
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
      const bundle = PragmaBundleSchema.parse({
        apiVersion: "pragma/v1",
        kind: "Bundle",
        resources: this.listResources(),
      });
      return { files: new Map([["pragma.yaml", stringify(bundle)]]) };
    }
    const files = new Map<string, string>();
    const imports: string[] = [];
    for (const indexed of this.resources.values()) {
      const path = `${resourceKind(indexed.resource)}s/${indexed.resource.metadata.id}.pragma.yaml`;
      imports.push(`./${path}`);
      files.set(path, stringify(indexed.resource));
    }
    files.set(
      "pragma.yaml",
      stringify({
        apiVersion: "pragma/v1",
        kind: "Bundle",
        imports: imports.sort(),
        resources: [],
      }),
    );
    files.set("pragma.lock.yaml", stringify(this.createLock()));
    return { files };
  }

  createLock(): PragmaLock {
    return {
      apiVersion: "pragma/v1",
      kind: "Lock",
      compilerVersion: COMPILER_VERSION,
      resources: [...this.resources.values()]
        .sort((left, right) =>
          canonicalRef(left.resource).localeCompare(canonicalRef(right.resource)),
        )
        .map((indexed) => ({
          ref: canonicalRef(indexed.resource),
          version: indexed.resource.metadata.version,
          contentHash: indexed.contentHash,
          source: relative(dirname(this.entryFile), indexed.source),
        })),
    };
  }

  private async validateLock(): Promise<PragmaDiagnostic[]> {
    const lockPath = resolve(dirname(this.entryFile), "pragma.lock.yaml");
    let lock: PragmaLock;
    try {
      lock = PragmaLockSchema.parse(parsePragmaYaml(await readFile(lockPath, "utf8")));
    } catch (error) {
      return [
        {
          severity: "error",
          code: "lock.invalid",
          message: error instanceof Error ? error.message : String(error),
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
        return (
          left === undefined ||
          right === undefined ||
          left.contentHash !== right.contentHash ||
          left.version !== right.version
        );
      },
    );
    if (lock.compilerVersion !== expected.compilerVersion) {
      mismatches.push(`compiler:${lock.compilerVersion}`);
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
    const parsed = parseNamespacedReference(ref);
    if (!new Set(["expert", "team", "flow"]).has(parsed.kind)) {
      throw new PragmaDslError(`Reference is not an invocable resource: ${ref}`);
    }
    const indexed = this.resources.get(`${parsed.kind}:${parsed.id}`);
    if (indexed === undefined) throw new PragmaDslError(`Pragma resource not found: ${ref}`);
    if (parsed.version !== undefined && indexed.resource.metadata.version !== parsed.version) {
      throw new PragmaDslError(
        `Pragma resource version mismatch: ${ref}; found ${indexed.resource.metadata.version}.`,
      );
    }
    return indexed;
  }

  private validateReferences(indexed: IndexedResource): PragmaDiagnostic[] {
    const diagnostics: PragmaDiagnostic[] = [];
    for (const ref of resourceDependencies(indexed.resource)) {
      try {
        this.resolveResource(ref);
      } catch (error) {
        diagnostics.push({
          severity: "error",
          code: "reference.invalid",
          message: error instanceof Error ? error.message : String(error),
          source: indexed.source,
          path: [],
        });
      }
    }
    return diagnostics;
  }
}

async function compileExpert(
  resource: PragmaExpertResource,
  tools: readonly ExpertAgentManagedTool<string, ExpertAgentToolCallResult>[],
  host: PragmaCompileHost,
): Promise<Expert> {
  if (host.createExpert !== undefined) {
    return await host.createExpert({ resource, tools, workspace: host.workspace });
  }
  if (resource.spec.capabilities.length > 0 || resource.spec.contextStores.length > 0) {
    throw new PragmaDslError(
      `Expert ${resource.metadata.id} requires a host capability/context resolver.`,
    );
  }
  return await defineExpert({
    id: resource.metadata.id,
    name: resource.metadata.name,
    description: resource.metadata.description,
    tags: resource.metadata.tags,
    version: resource.metadata.version,
    scope: resource.spec.scope,
    instructions: resource.spec.instructions,
    workspace: host.workspace,
    tools,
    plugins: resource.spec.plugins,
    ...host.expertOptions?.(resource),
  });
}

async function compileFlowResource(
  resource: PragmaFlowResource,
  instantiate: (ref: string) => Promise<InvocableResource>,
  actions: FlowActionRegistry,
  contextPolicies: ContextPolicyRegistry,
): Promise<Flow> {
  const inputSchema = createJsonSchemaZod(resource.spec.input?.schema);
  const outputSchema = createJsonSchemaZod(resource.spec.output?.schema);
  const flow = defineFlow({
    id: resource.metadata.id,
    version: resource.metadata.version,
    input: inputSchema,
    output: outputSchema,
    maxNodeVisits: resource.spec.limits.maxNodeVisits,
    result: ({ state }) =>
      evaluateValue(resource.spec.output?.value ?? state, state, undefined, state),
  });
  const references = new Map<string, FlowStepReference>();
  for (const [stepId, step] of Object.entries(resource.spec.graph.steps)) {
    const input =
      step.input === undefined
        ? undefined
        : ({ state, flowInput }: { state: FlowState; flowInput: unknown }) =>
            evaluateValue(step.input, state, flowInput);
    const reduce =
      step.save === undefined
        ? undefined
        : ({ state, output }: { state: FlowState; output: unknown }) => {
            writeStatePath(state, step.save!, output);
          };
    if (step.action !== undefined) {
      const action = actions.resolve(step.action.ref);
      references.set(
        stepId,
        flow.task({
          id: stepId,
          version: step.version,
          input,
          reduce,
          inputSchema: createJsonSchemaZod(action.inputSchema),
          outputSchema: createJsonSchemaZod(action.outputSchema),
          handler: async (context) => await action.execute(context),
        }),
      );
      continue;
    }
    if (step.human !== undefined) {
      references.set(
        stepId,
        flow.humanTask({
          id: stepId,
          version: step.version,
          input,
          reduce,
          request: ({ input: stepInput, state }) =>
            compileHumanRequest(step.human!, state, stepInput),
        }),
      );
      continue;
    }
    const targetRef = step.expert?.ref ?? step.team?.ref ?? step.flow?.ref;
    if (targetRef === undefined) throw new PragmaDslError(`Flow step has no target: ${stepId}`);
    const target = await instantiate(targetRef);
    const options = {
      input,
      reduce,
      runtime: step.runtime,
      runtimeByExpert: step.runtimes,
      contextId: step.context === undefined ? undefined : contextPolicies.resolve(step.context),
    };
    references.set(
      stepId,
      "kind" in target && target.kind === "flow"
        ? flow.use(stepId, target, { input, reduce })
        : flow.use(stepId, target as ExpertDefinition, options),
    );
  }
  const start = references.get(resource.spec.graph.start);
  if (start === undefined)
    throw new PragmaDslError(`Unknown Flow start: ${resource.spec.graph.start}`);
  flow.compose(({ start: begin }) => begin(start));

  const loopMembers = validateAndReadLoopMembers(resource);
  for (const [loopId, loop] of Object.entries(resource.spec.graph.loops)) {
    flow.loop({
      id: loopId,
      entry: requireStepReference(references, loop.entry),
      steps: [...(loopMembers.get(loopId) ?? [])].map((id) => requireStepReference(references, id)),
      maxIterations: loop.maxIterations,
      onLimit: loop.onLimit === undefined ? undefined : compileTarget(loop.onLimit, references),
    });
  }
  for (const [stepId, transition] of Object.entries(resource.spec.graph.transitions)) {
    flow.setTransition(stepId, compileTransition(transition, references));
  }
  return flow.compile();
}

function compileTransition(
  transition: PragmaFlowTransition,
  references: ReadonlyMap<string, FlowStepReference>,
) {
  if (
    typeof transition === "string" ||
    "goto" in transition ||
    "end" in transition ||
    "fail" in transition
  ) {
    return { type: "next" as const, target: compileTarget(transition, references) };
  }
  if ("repeat" in transition) {
    return {
      type: "repeat" as const,
      loopId: transition.repeat.loop,
      target: requireStepReference(references, transition.repeat.goto),
    };
  }
  return {
    type: "route" as const,
    field: transition.route,
    cases: new Map(
      Object.entries(transition.cases).map(([key, target]) => [
        key,
        compileDestination(target, references),
      ]),
    ),
    fallback:
      transition.fallback === undefined
        ? undefined
        : compileDestination(transition.fallback, references),
  };
}

function compileDestination(
  target: PragmaFlowDestination,
  references: ReadonlyMap<string, FlowStepReference>,
) {
  return typeof target === "object" && "repeat" in target
    ? {
        type: "repeat" as const,
        loopId: target.repeat.loop,
        target: requireStepReference(references, target.repeat.goto),
      }
    : compileTarget(target, references);
}

function compileTarget(
  target: PragmaFlowTarget,
  references: ReadonlyMap<string, FlowStepReference>,
): FlowStepReference | FlowTerminal {
  if (typeof target === "string") return requireStepReference(references, target);
  if ("goto" in target) return requireStepReference(references, target.goto);
  if ("end" in target) return { type: "end" };
  return { type: "fail", reason: target.fail };
}

function compileHumanRequest(
  request: NonNullable<PragmaFlowResource["spec"]["graph"]["steps"][string]["human"]>,
  state: FlowState,
  input: unknown,
) {
  return {
    kind: request.kind,
    title:
      request.title === undefined ? undefined : String(evaluateValue(request.title, state, input)),
    prompt:
      request.prompt === undefined
        ? undefined
        : String(evaluateValue(request.prompt, state, input)),
    questions: request.questions?.map((question) => ({
      header: question.id,
      question: question.label,
      kind: question.type,
      options: question.options.map((option) => ({ label: option, description: option })),
    })),
  };
}

function evaluateValue(
  value: unknown,
  state: FlowState,
  flowInput: unknown,
  nodeOutput?: unknown,
): unknown {
  if (typeof value === "string") {
    if (value === "$flow.input") return flowInput;
    if (value === "$node.output") return nodeOutput;
    if (value.startsWith("$state.")) return readPath(state, value.slice("$state.".length));
    return value.replace(/\{\{\s*([^}|]+?)\s*(\|\s*json)?\s*\}\}/g, (_match, expression, json) => {
      const resolved = evaluateValue(
        `$${String(expression).trim().replace(/^\$/, "")}`,
        state,
        flowInput,
        nodeOutput,
      );
      return json === undefined ? String(resolved ?? "") : JSON.stringify(resolved, null, 2);
    });
  }
  if (Array.isArray(value))
    return value.map((entry) => evaluateValue(entry, state, flowInput, nodeOutput));
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        evaluateValue(entry, state, flowInput, nodeOutput),
      ]),
    );
  }
  return value;
}

function readPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, segment) => {
    if (typeof current !== "object" || current === null) return undefined;
    return (current as Record<string, unknown>)[segment];
  }, value);
}

function writeStatePath(state: FlowState, path: string, value: unknown): void {
  if (path.startsWith("state.__pragma"))
    throw new PragmaDslError("The __pragma state namespace is reserved.");
  const segments = path.replace(/^state\./, "").split(".");
  let current: Record<string, unknown> = state;
  for (const segment of segments.slice(0, -1)) {
    const existing = current[segment];
    if (typeof existing === "object" && existing !== null && !Array.isArray(existing)) {
      current = existing as Record<string, unknown>;
    } else {
      const created: Record<string, unknown> = {};
      current[segment] = created;
      current = created;
    }
  }
  current[segments.at(-1)!] = value;
}

function createJsonSchemaZod(schema: unknown): z.ZodTypeAny | undefined {
  if (schema === undefined) return undefined;
  const validator = new Validator(schema as Schema | boolean, "2020-12", false);
  return z.custom((value) => validator.validate(value).valid, "Value does not match JSON Schema.");
}

function validateFlowGraph(indexed: IndexedResource): PragmaDiagnostic[] {
  try {
    validateAndReadLoopMembers(indexed.resource as PragmaFlowResource);
    return [];
  } catch (error) {
    return [
      {
        severity: "error",
        code: "flow.graph.invalid",
        message: error instanceof Error ? error.message : String(error),
        source: indexed.source,
        path: ["spec", "graph"],
      },
    ];
  }
}

function validateAndReadLoopMembers(
  resource: PragmaFlowResource,
): Map<string, ReadonlySet<string>> {
  const graph = resource.spec.graph;
  const stepIds = new Set(Object.keys(graph.steps));
  if (!stepIds.has(graph.start))
    throw new PragmaDslError(`Unknown Flow start step: ${graph.start}`);
  for (const stepId of stepIds) {
    if (graph.transitions[stepId] === undefined) {
      throw new PragmaDslError(`Flow step has no transition: ${stepId}`);
    }
  }
  const edges = transitionEdges(graph.transitions);
  for (const [source, targets] of edges) {
    if (!stepIds.has(source)) throw new PragmaDslError(`Transition source is unknown: ${source}`);
    for (const target of targets) {
      if (!stepIds.has(target)) throw new PragmaDslError(`Transition target is unknown: ${target}`);
    }
  }
  const repeatEdges = new Set<string>();
  for (const [source, transition] of Object.entries(graph.transitions)) {
    for (const destination of transitionDestinations(transition)) {
      if (typeof destination !== "object" || !("repeat" in destination)) continue;
      const loop = graph.loops[destination.repeat.loop];
      if (loop === undefined)
        throw new PragmaDslError(`Unknown Flow loop: ${destination.repeat.loop}`);
      if (destination.repeat.goto !== loop.entry) {
        throw new PragmaDslError(
          `Loop ${destination.repeat.loop} repeat must target ${loop.entry}.`,
        );
      }
      repeatEdges.add(`${source}->${destination.repeat.goto}`);
    }
  }
  if (hasCycle(stepIds, edges, repeatEdges)) {
    throw new PragmaDslError(
      "Flow contains a cycle that is not broken by an explicit repeat edge.",
    );
  }
  const components = stronglyConnectedComponents(stepIds, edges);
  const cyclic = components.filter(
    (component) => component.size > 1 || [...component].some((id) => edges.get(id)?.has(id)),
  );
  const result = new Map<string, ReadonlySet<string>>();
  for (const component of cyclic) {
    const matching = Object.entries(graph.loops).filter(([, loop]) => component.has(loop.entry));
    if (matching.length !== 1)
      throw new PragmaDslError("Every cyclic Flow region must have exactly one Loop.");
    const [loopId, loop] = matching[0]!;
    for (const [source, targets] of edges) {
      if (component.has(source)) continue;
      for (const target of targets) {
        if (component.has(target) && target !== loop.entry) {
          throw new PragmaDslError(`Loop ${loopId} has a non-entry incoming edge to ${target}.`);
        }
      }
    }
    result.set(loopId, component);
  }
  for (const [loopId, loop] of Object.entries(graph.loops)) {
    if (!stepIds.has(loop.entry)) throw new PragmaDslError(`Loop entry is unknown: ${loop.entry}`);
    if (!result.has(loopId))
      throw new PragmaDslError(`Loop ${loopId} does not describe a control-flow cycle.`);
  }
  return result;
}

function transitionEdges(
  transitions: PragmaFlowResource["spec"]["graph"]["transitions"],
): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  const addTarget = (source: string, target: PragmaFlowDestination): void => {
    const id =
      typeof target === "string"
        ? target
        : "goto" in target
          ? target.goto
          : "repeat" in target
            ? target.repeat.goto
            : undefined;
    if (id !== undefined) (edges.get(source) ?? edges.set(source, new Set()).get(source)!).add(id);
  };
  for (const [source, transition] of Object.entries(transitions)) {
    edges.set(source, edges.get(source) ?? new Set());
    if (
      typeof transition === "string" ||
      "goto" in transition ||
      "end" in transition ||
      "fail" in transition
    ) {
      addTarget(source, transition);
    } else if ("repeat" in transition) {
      addTarget(source, transition.repeat.goto);
    } else {
      for (const target of Object.values(transition.cases)) addTarget(source, target);
      if (transition.fallback !== undefined) addTarget(source, transition.fallback);
    }
  }
  return edges;
}

function transitionDestinations(
  transition: PragmaFlowTransition,
): readonly PragmaFlowDestination[] {
  if (
    typeof transition === "string" ||
    "goto" in transition ||
    "end" in transition ||
    "fail" in transition ||
    "repeat" in transition
  ) {
    return [transition];
  }
  return [
    ...Object.values(transition.cases),
    ...(transition.fallback === undefined ? [] : [transition.fallback]),
  ];
}

function stronglyConnectedComponents(
  nodes: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
): ReadonlySet<string>[] {
  let index = 0;
  const indexes = new Map<string, number>();
  const lowLinks = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const result: Set<string>[] = [];
  const visit = (node: string): void => {
    indexes.set(node, index);
    lowLinks.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!indexes.has(target)) {
        visit(target);
        lowLinks.set(node, Math.min(lowLinks.get(node)!, lowLinks.get(target)!));
      } else if (onStack.has(target)) {
        lowLinks.set(node, Math.min(lowLinks.get(node)!, indexes.get(target)!));
      }
    }
    if (lowLinks.get(node) !== indexes.get(node)) return;
    const component = new Set<string>();
    while (stack.length > 0) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.add(member);
      if (member === node) break;
    }
    result.push(component);
  };
  for (const node of nodes) if (!indexes.has(node)) visit(node);
  return result;
}

function hasCycle(
  nodes: ReadonlySet<string>,
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  ignored: ReadonlySet<string>,
): boolean {
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (node: string): boolean => {
    if (visiting.has(node)) return true;
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const target of edges.get(node) ?? []) {
      if (!ignored.has(`${node}->${target}`) && visit(target)) return true;
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };
  return [...nodes].some(visit);
}

function validateResourceCycles(
  resources: ReadonlyMap<string, IndexedResource>,
): PragmaDiagnostic[] {
  const edges = new Map<string, Set<string>>();
  for (const [key, indexed] of resources) {
    edges.set(
      key,
      new Set(
        resourceDependencies(indexed.resource)
          .map((ref) => parseNamespacedReference(ref))
          .filter((parsed) => new Set(["expert", "team", "flow"]).has(parsed.kind))
          .map((parsed) => `${parsed.kind}:${parsed.id}`),
      ),
    );
  }
  if (!hasCycle(new Set(resources.keys()), edges, new Set())) return [];
  return [
    {
      severity: "error",
      code: "resource.cycle",
      message: "Pragma resource definitions must form an acyclic dependency graph.",
      path: [],
    },
  ];
}

function resourceDependencies(resource: PragmaResource): string[] {
  if (resource.kind === "Expert") {
    return resource.spec.tools.flatMap((binding) =>
      binding.target === undefined
        ? binding.targets!.map((target) => target.ref)
        : [binding.target.ref],
    );
  }
  if (resource.kind === "ExpertTeam") {
    return [resource.spec.coordinator.ref, ...resource.spec.members.map((member) => member.ref)];
  }
  return Object.values(resource.spec.graph.steps).flatMap((step) => {
    const ref = step.expert?.ref ?? step.team?.ref ?? step.flow?.ref;
    return ref === undefined ? [] : [ref];
  });
}

function collectLockedDependencies(
  root: IndexedResource,
  resources: ReadonlyMap<string, IndexedResource>,
): LockedResourceRef[] {
  const result = new Map<string, LockedResourceRef>();
  const visit = (indexed: IndexedResource): void => {
    for (const ref of resourceDependencies(indexed.resource)) {
      const parsed = parseNamespacedReference(ref);
      if (!new Set(["expert", "team", "flow"]).has(parsed.kind)) continue;
      const dependency = resources.get(`${parsed.kind}:${parsed.id}`);
      if (dependency === undefined || result.has(resourceKey(dependency.resource))) continue;
      result.set(resourceKey(dependency.resource), {
        ref: canonicalRef(dependency.resource),
        version: dependency.resource.metadata.version,
        contentHash: dependency.contentHash,
        source: dependency.source,
      });
      visit(dependency);
    }
  };
  visit(root);
  return [...result.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

function isPlainExpert(value: InvocableResource): value is Expert {
  return !("kind" in value);
}

function requireStepReference(
  references: ReadonlyMap<string, FlowStepReference>,
  id: string,
): FlowStepReference {
  const reference = references.get(id);
  if (reference === undefined) throw new PragmaDslError(`Unknown Flow step: ${id}`);
  return reference;
}

function resourceKind(resource: PragmaResource): "expert" | "team" | "flow" {
  return resource.kind === "Expert" ? "expert" : resource.kind === "ExpertTeam" ? "team" : "flow";
}

function resourceKey(resource: PragmaResource): string {
  return `${resourceKind(resource)}:${resource.metadata.id}`;
}

function canonicalRef(resource: PragmaResource): PragmaResourceRef {
  return `${resourceKey(resource)}@${resource.metadata.version}` as PragmaResourceRef;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableStringify(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
