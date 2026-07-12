import {
  createDefaultRuntimeRegistry,
  createDefaultRuntimeRegistryIfConfigured,
} from "../runtime/default-runtime-registry.ts";
import type { ExpertAgentRuntimeRegistry } from "../runtime/default-runtime-registry.ts";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";
import { agentLauncherDefinitions } from "../agent/agent-launcher.ts";
import { compileDirectiveDefinition } from "./flow-spec.ts";
import { createInMemoryDirectiveDefinitionStore } from "./in-memory-directive-definition-store.ts";
import { createInMemoryMailbox } from "./in-memory-mailbox.ts";
import { createInMemoryStateManager } from "./in-memory-state-manager.ts";
import { createFileStateManager } from "./file-state-manager.ts";
import { createFileRunEventStore, createInMemoryRunEventStore } from "./run-event-store.ts";
import { createLocalSandboxManager } from "./local-sandbox-manager.ts";
import { createRunObserver } from "./run-observer.ts";
import { createPragmaTaskManager } from "./task-manager.ts";
import type {
  CompiledDirective,
  CreatePragmaOptions,
  Directive,
  PragmaApp,
  DirectiveDefinition,
  RunResult,
  RunHandle,
  StateManager,
  StartRunRequest,
} from "./types.ts";

export function createPragma(options: CreatePragmaOptions = {}): PragmaApp {
  const storage = options.storage ?? "file";
  const mailbox = options.mailbox ?? createInMemoryMailbox();
  const stateManager =
    options.stateManager ??
    (storage === "file"
      ? createFileStateManager({ pragmaHome: options.pragmaHome })
      : createInMemoryStateManager());
  const eventStore =
    options.eventStore ??
    (storage === "file"
      ? createFileRunEventStore({ pragmaHome: options.pragmaHome })
      : createInMemoryRunEventStore());
  const directiveStore = options.directiveStore ?? createInMemoryDirectiveDefinitionStore();
  const runtimes = options.runtimes ?? createPragmaRuntimeRegistry(options.defaultRuntime);
  const sandboxManager = options.sandboxManager ?? createLocalSandboxManager();
  const activeHandles = new Map<string, RunHandle>();
  const childInvocationOffsets = new Map<string, number>();
  const startDirective = async <TInput, TOutput>(
    directive: DirectiveDefinition<TInput, TOutput>,
    request: StartRunRequest<TInput>,
    eventMode: "stream" | "none" = "stream",
  ) => {
    const compiledDirective = compileDirective(
      directive,
      request.output as CompiledDirective<TInput, TOutput>["outputSchema"] | undefined,
    );
    if (request.execution !== undefined) {
      if (request.continuationKey !== undefined) {
        const reusable = (await stateManager.listWorkflowRuns())
          .filter(
            (workflow) =>
              workflow.rootWorkflowRunId === request.execution?.workflow.rootWorkflowRunId &&
              workflow.continuationKey === request.continuationKey &&
              workflow.directiveId === compiledDirective.id &&
              workflow.directiveVersion === compiledDirective.version,
          )
          .sort((left, right) => left.createdAt.localeCompare(right.createdAt))[0];
        if (reusable !== undefined) {
          const active = activeHandles.get(reusable.id);
          if (active !== undefined && reusable.status !== "succeeded") {
            return active as RunHandle<TOutput>;
          }
          const continued =
            reusable.status === "succeeded"
              ? await taskManager.continueRun(compiledDirective, reusable.id, request, {
                  events: eventMode,
                })
              : await taskManager.resumeRun<TOutput>(
                  compiledDirective as CompiledDirective<unknown, TOutput>,
                  reusable.id,
                  { events: eventMode },
                );
          activeHandles.set(reusable.id, continued);
          return continued;
        }
      }
      const parentTaskRunId = request.execution.task.id;
      const offset = childInvocationOffsets.get(parentTaskRunId) ?? 0;
      childInvocationOffsets.set(parentTaskRunId, offset + 1);
      const matching = (
        await stateManager.listWorkflowRuns({
          parentWorkflowRunId: request.execution.workflow.id,
        })
      )
        .filter(
          (workflow) =>
            workflow.parentTaskRunId === parentTaskRunId &&
            workflow.directiveId === compiledDirective.id &&
            workflow.directiveVersion === compiledDirective.version,
        )
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
      const existing = matching[offset];
      if (existing !== undefined) {
        const active = activeHandles.get(existing.id);
        if (active !== undefined) return active as RunHandle<TOutput>;
        const resumed = await taskManager.resumeRun<TOutput>(
          compiledDirective as CompiledDirective<unknown, TOutput>,
          existing.id,
          { events: eventMode },
        );
        activeHandles.set(existing.id, resumed);
        return resumed;
      }
    }
    const handle = await taskManager.startRun(compiledDirective, request, { events: eventMode });
    activeHandles.set(handle.workflowRunId, handle);
    return handle;
  };
  const runDirective = async <TInput, TOutput>(
    directive: DirectiveDefinition<TInput, TOutput>,
    request: StartRunRequest<TInput>,
  ): Promise<RunResult<TOutput>> => {
    const handle = await startDirective(directive, request, "none");
    return await handle.result;
  };
  const taskManager =
    options.taskManager ??
    createPragmaTaskManager(
      {
        mailbox,
        stateManager,
        runtimes,
        sandboxManager,
        directiveStore,
        eventStore,
      },
      runDirective,
    );
  const runs = createRunObserver({
    stateManager,
    eventStore,
  });

  return {
    mailbox,
    stateManager,
    taskManager,
    runtimes,
    runs,
    start: async (directive, request) => await startDirective(directive, request, "stream"),
    run: runDirective,
    resume: async (directive, request) => {
      const compiled = compileDirective(directive, undefined);
      const root = await stateManager.getWorkflowRun(request.workflowRunId);
      if (root === undefined)
        throw new Error(`Workflow run is not found: ${request.workflowRunId}`);
      if (root.parentWorkflowRunId !== undefined) {
        throw new Error(`Only a Root Workflow can be resumed: ${request.workflowRunId}`);
      }
      const definitions = collectDefinitions(compiled);
      const tree = await collectWorkflowTree(stateManager, request.workflowRunId);
      for (const workflow of tree) {
        const current = definitions.get(workflow.directiveId);
        if (current === undefined || current.version !== workflow.directiveVersion) {
          throw new Error(
            `Workflow definition mismatch for ${workflow.id}: persisted ${workflow.directiveId}@${workflow.directiveVersion}.`,
          );
        }
        for (const task of await stateManager.listTaskRuns(workflow.id)) {
          const taskDefinition = definitions.get(task.definition.id);
          if (taskDefinition === undefined || taskDefinition.version !== task.definition.version) {
            throw new Error(
              `Task definition mismatch for ${task.id}: persisted ${task.definition.id}@${task.definition.version}.`,
            );
          }
        }
      }
      for (const workflow of [...tree].reverse()) {
        if (workflow.id === request.workflowRunId) continue;
        const childDefinition = definitions.get(workflow.directiveId);
        if (childDefinition === undefined) continue;
        const handle = await taskManager.resumeRun(childDefinition.compiled, workflow.id, {
          events: "none",
        });
        activeHandles.set(workflow.id, handle);
      }
      const handle = await taskManager.resumeRun(compiled, request.workflowRunId);
      activeHandles.set(request.workflowRunId, handle);
      return handle;
    },
  };
}

interface CollectedDefinition {
  readonly version: string;
  readonly compiled: CompiledDirective;
}

function collectDefinitions(root: CompiledDirective): ReadonlyMap<string, CollectedDefinition> {
  const definitions = new Map<string, CollectedDefinition>();
  const visit = (directive: DirectiveDefinition) => {
    const compiled = compileDirective(directive, undefined);
    const existing = definitions.get(compiled.id);
    if (existing !== undefined && existing.version !== compiled.version) {
      throw new Error(`Ambiguous definition versions for ${compiled.id}.`);
    }
    if (existing !== undefined) {
      visitDeclaredChildren(directive);
      return;
    }
    definitions.set(compiled.id, { version: compiled.version, compiled });
    for (const step of compiled.steps.values()) visit(step.directive);
    visitDeclaredChildren(directive);
  };
  const visitDeclaredChildren = (directive: DirectiveDefinition) => {
    if ("children" in directive) {
      for (const child of directive.children ?? []) visit(child);
    }
    const tools = "tools" in directive ? directive.tools : undefined;
    if (Array.isArray(tools)) {
      for (const tool of tools) {
        if (typeof tool !== "object" || tool === null) continue;
        const children = (tool as { [agentLauncherDefinitions]?: readonly DirectiveDefinition[] })[
          agentLauncherDefinitions
        ];
        for (const child of children ?? []) visit(child);
      }
    }
  };
  visit(root);
  return definitions;
}

async function collectWorkflowTree(stateManager: StateManager, rootWorkflowRunId: string) {
  const result = [];
  const pending = [rootWorkflowRunId];
  while (pending.length > 0) {
    const id = pending.shift();
    if (id === undefined) continue;
    const workflow = await stateManager.getWorkflowRun(id);
    if (workflow === undefined) throw new Error(`Workflow run is not found: ${id}`);
    result.push(workflow);
    const children = await stateManager.listWorkflowRuns({ parentWorkflowRunId: id });
    pending.push(...children.map((child) => child.id));
  }
  return result;
}

function createPragmaRuntimeRegistry(defaultRuntime?: string | undefined): RuntimeRegistry {
  let configuredRegistry: ExpertAgentRuntimeRegistry | undefined;

  const maybeResolveConfiguredRegistry = () => {
    configuredRegistry ??= createDefaultRuntimeRegistryIfConfigured();
    return configuredRegistry;
  };
  const resolveConfiguredRegistry = () => {
    configuredRegistry ??= createDefaultRuntimeRegistry();
    return configuredRegistry;
  };
  const resolveDefaultRuntime = () =>
    defaultRuntime ?? maybeResolveConfiguredRegistry()?.defaultRuntime ?? "default";

  return {
    get defaultRuntime() {
      return resolveDefaultRuntime();
    },
    list() {
      const registry = maybeResolveConfiguredRegistry();

      if (isFullRuntimeRegistry(registry)) {
        return registry.list();
      }

      return [];
    },
    get(runtimeId: string) {
      const registry = maybeResolveConfiguredRegistry();

      if (isFullRuntimeRegistry(registry)) {
        return registry.get(runtimeId);
      }

      try {
        return registry?.resolve(runtimeId);
      } catch {
        return undefined;
      }
    },
    resolve(runtimeId?: string | undefined) {
      return resolveConfiguredRegistry().resolve(runtimeId ?? defaultRuntime);
    },
  };
}

function isFullRuntimeRegistry(
  registry: ExpertAgentRuntimeRegistry | undefined,
): registry is ExpertAgentRuntimeRegistry & {
  readonly list: () => readonly RuntimeAdapter[];
  readonly get: (runtimeId: string) => RuntimeAdapter | undefined;
} {
  return (
    registry !== undefined &&
    "list" in registry &&
    typeof registry.list === "function" &&
    "get" in registry &&
    typeof registry.get === "function"
  );
}

function compileDirective<TInput, TOutput>(
  directive: DirectiveDefinition<TInput, TOutput>,
  output?: CompiledDirective<TInput, TOutput>["outputSchema"] | undefined,
): CompiledDirective<TInput, TOutput> {
  const runnable = compileDirectiveDefinition(directive);

  if (isCompiledDirective(runnable)) {
    return runnable;
  }

  return compileSingleStepDirective(runnable, output);
}

function isCompiledDirective<TInput, TOutput>(
  directive: Directive<TInput, TOutput>,
): directive is CompiledDirective<TInput, TOutput> {
  return "steps" in directive && "startStepId" in directive && "transitions" in directive;
}

function compileSingleStepDirective<TInput, TOutput>(
  directive: Directive<TInput, TOutput>,
  output?: CompiledDirective<TInput, TOutput>["outputSchema"] | undefined,
): CompiledDirective<TInput, TOutput> {
  const stepId = directive.id;
  const outputSchema = output ?? directive.outputSchema;
  const compiled: CompiledDirective<TInput, TOutput> = {
    id: directive.id,
    version: directive.version,
    inputSchema: directive.inputSchema,
    outputSchema,
    resolveOutput: ({ state }) => state.results["final"] as TOutput,
    steps: new Map([
      [
        stepId,
        {
          id: stepId,
          directive,
          output: outputSchema,
          reduce: ({ state, output }) => {
            state.results["final"] = output;
          },
        },
      ],
    ]),
    startStepId: stepId,
    transitions: [
      {
        type: "next",
        from: stepId,
        to: {
          type: "end",
        },
      },
    ],
    limits: new Map(),
  };

  return compiled;
}
