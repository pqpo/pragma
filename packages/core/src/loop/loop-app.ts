import { createRuntimeRegistry } from "../runtime-registry.ts";
import { compileLoopDefinition } from "./flow-spec.ts";
import { createInMemoryLoopDefinitionStore } from "./in-memory-loop-definition-store.ts";
import { createInMemoryMailbox } from "./in-memory-mailbox.ts";
import { createInMemoryStateManager } from "./in-memory-state-manager.ts";
import { createLocalSandboxManager } from "./local-sandbox-manager.ts";
import { createLoopRunObserver } from "./loop-run-observer.ts";
import { createLocalTaskManager } from "./task-manager.ts";
import type {
  CompiledLoop,
  CreateLoopAppOptions,
  Loop,
  LoopApp,
  LoopDefinition,
  LoopRunResult,
  StartLoopRunRequest,
} from "./types.ts";

export function createPragma(options: CreateLoopAppOptions = {}): LoopApp {
  const mailbox = options.mailbox ?? createInMemoryMailbox();
  const stateManager = options.stateManager ?? createInMemoryStateManager();
  const loopStore = options.loopStore ?? createInMemoryLoopDefinitionStore();
  const runtimes =
    options.runtimes ??
    createRuntimeRegistry({
      defaultRuntime: options.defaultRuntime,
    });
  const sandboxManager = options.sandboxManager ?? createLocalSandboxManager();
  const startLoop = async <TInput, TOutput>(
    loop: LoopDefinition<TInput, TOutput>,
    request: StartLoopRunRequest<TInput>,
  ) => {
    const compiledLoop = compileLoop(
      loop,
      request.output as CompiledLoop<TInput, TOutput>["outputSchema"] | undefined,
    );
    return await taskManager.startRun(compiledLoop, request);
  };
  const runLoop = async <TInput, TOutput>(
    loop: LoopDefinition<TInput, TOutput>,
    request: StartLoopRunRequest<TInput>,
  ): Promise<LoopRunResult<TOutput>> => {
    const handle = await startLoop(loop, request);
    return await handle.result;
  };
  const taskManager =
    options.taskManager ??
    createLocalTaskManager({
      mailbox,
      stateManager,
      runtimes,
      sandboxManager,
      loopStore,
      runLoop,
    });
  const runs = createLoopRunObserver({
    mailbox,
    stateManager,
  });

  return {
    mailbox,
    stateManager,
    taskManager,
    runtimes,
    runs,
    start: startLoop,
    run: runLoop,
  };
}

function compileLoop<TInput, TOutput>(
  loop: LoopDefinition<TInput, TOutput>,
  output?: CompiledLoop<TInput, TOutput>["outputSchema"] | undefined,
): CompiledLoop<TInput, TOutput> {
  const runnable = compileLoopDefinition(loop);

  if (isCompiledLoop(runnable)) {
    return runnable;
  }

  return compileSingleStepLoop(runnable, output);
}

function isCompiledLoop<TInput, TOutput>(
  loop: Loop<TInput, TOutput>,
): loop is CompiledLoop<TInput, TOutput> {
  return "steps" in loop && "startStepId" in loop && "transitions" in loop;
}

function compileSingleStepLoop<TInput, TOutput>(
  loop: Loop<TInput, TOutput>,
  output?: CompiledLoop<TInput, TOutput>["outputSchema"] | undefined,
): CompiledLoop<TInput, TOutput> {
  const stepId = loop.id;
  const outputSchema = output ?? loop.outputSchema;
  const compiled: CompiledLoop<TInput, TOutput> = {
    id: loop.id,
    inputSchema: loop.inputSchema,
    outputSchema,
    resolveOutput: ({ state }) => state.results["final"] as TOutput,
    steps: new Map([
      [
        stepId,
        {
          id: stepId,
          loop,
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
