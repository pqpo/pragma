import {
  createDefaultRuntimeRegistry,
  createDefaultRuntimeRegistryIfConfigured,
} from "../runtime/default-runtime-registry.ts";
import type { ExpertAgentRuntimeRegistry } from "../runtime/default-runtime-registry.ts";
import type { RuntimeAdapter } from "../runtime/runtime-adapter.ts";
import type { RuntimeRegistry } from "../runtime-registry.ts";
import { compileDirectiveDefinition } from "./flow-spec.ts";
import { createInMemoryDirectiveDefinitionStore } from "./in-memory-directive-definition-store.ts";
import { createInMemoryMailbox } from "./in-memory-mailbox.ts";
import { createInMemoryStateManager } from "./in-memory-state-manager.ts";
import { createLocalSandboxManager } from "./local-sandbox-manager.ts";
import { createRunObserver } from "./run-observer.ts";
import { createLocalTaskManager } from "./task-manager.ts";
import type {
  CompiledDirective,
  CreatePragmaOptions,
  Directive,
  Pragma,
  DirectiveDefinition,
  RunResult,
  StartRunRequest,
} from "./types.ts";

export function createPragma(options: CreatePragmaOptions = {}): Pragma {
  const mailbox = options.mailbox ?? createInMemoryMailbox();
  const stateManager = options.stateManager ?? createInMemoryStateManager();
  const directiveStore = options.directiveStore ?? createInMemoryDirectiveDefinitionStore();
  const runtimes = options.runtimes ?? createPragmaRuntimeRegistry(options.defaultRuntime);
  const sandboxManager = options.sandboxManager ?? createLocalSandboxManager();
  const startDirective = async <TInput, TOutput>(
    directive: DirectiveDefinition<TInput, TOutput>,
    request: StartRunRequest<TInput>,
  ) => {
    const compiledDirective = compileDirective(
      directive,
      request.output as CompiledDirective<TInput, TOutput>["outputSchema"] | undefined,
    );
    return await taskManager.startRun(compiledDirective, request);
  };
  const runDirective = async <TInput, TOutput>(
    directive: DirectiveDefinition<TInput, TOutput>,
    request: StartRunRequest<TInput>,
  ): Promise<RunResult<TOutput>> => {
    const handle = await startDirective(directive, request);
    return await handle.result;
  };
  const taskManager =
    options.taskManager ??
    createLocalTaskManager({
      mailbox,
      stateManager,
      runtimes,
      sandboxManager,
      directiveStore,
      runDirective,
    });
  const runs = createRunObserver({
    mailbox,
    stateManager,
  });

  return {
    mailbox,
    stateManager,
    taskManager,
    runtimes,
    runs,
    start: startDirective,
    run: runDirective,
  };
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
    async run(request) {
      return await createPragma().run(compiled, request);
    },
  };

  return compiled;
}
