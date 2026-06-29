import { createRuntimeRegistry } from "../runtime-registry.ts";
import { createInMemoryMailbox } from "./in-memory-mailbox.ts";
import { createInMemoryStateManager } from "./in-memory-state-manager.ts";
import { createLocalTaskExecutionEnvironment } from "./local-task-execution-environment.ts";
import { createLocalTaskManager } from "./task-manager.ts";
import type {
  CompiledLoop,
  CreateLoopAppOptions,
  Loop,
  LoopApp,
  LoopCompiler,
  LoopRunResult,
  StartLoopRunRequest,
} from "./types.ts";

export function createLoopApp(options: CreateLoopAppOptions = {}): LoopApp {
  const mailbox = options.mailbox ?? createInMemoryMailbox();
  const stateManager = options.stateManager ?? createInMemoryStateManager();
  const runtimes =
    options.runtimes ??
    createRuntimeRegistry({
      defaultRuntime: options.defaultRuntime,
    });
  const environment = options.environment ?? createLocalTaskExecutionEnvironment();
  const runLoop = async <TInput, TOutput>(
    loop: Loop<TInput, TOutput> | LoopCompiler<TInput, TOutput>,
    request: StartLoopRunRequest<TInput>,
  ): Promise<LoopRunResult<TOutput>> => {
    const compiledLoop = compileLoop(
      loop,
      request.output as CompiledLoop<TInput, TOutput>["outputSchema"] | undefined,
    );
    const handle = await taskManager.startRun(compiledLoop, request);
    return await handle.result;
  };
  const taskManager =
    options.taskManager ??
    createLocalTaskManager({
      mailbox,
      stateManager,
      runtimes,
      environment,
      runLoop,
    });

  return {
    mailbox,
    stateManager,
    taskManager,
    runtimes,
    run: runLoop,
  };
}

function compileLoop<TInput, TOutput>(
  loop: Loop<TInput, TOutput> | LoopCompiler<TInput, TOutput>,
  output?: CompiledLoop<TInput, TOutput>["outputSchema"] | undefined,
): CompiledLoop<TInput, TOutput> {
  const runnable = "compile" in loop ? loop.compile() : loop;

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
      return await createLoopApp().run(compiled, request);
    },
  };

  return compiled;
}
