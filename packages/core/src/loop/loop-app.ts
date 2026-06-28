import { createRuntimeRegistry } from "../runtime-registry.ts";
import { createInMemoryMailbox } from "./in-memory-mailbox.ts";
import { createInMemoryStateManager } from "./in-memory-state-manager.ts";
import { createLocalTaskExecutionEnvironment } from "./local-task-execution-environment.ts";
import { createLocalTaskManager } from "./task-manager.ts";
import type { CompiledLoop, CreateLoopAppOptions, LoopApp, LoopCompiler } from "./types.ts";

export function createLoopApp(options: CreateLoopAppOptions = {}): LoopApp {
  const mailbox = options.mailbox ?? createInMemoryMailbox();
  const stateManager = options.stateManager ?? createInMemoryStateManager();
  const runtimes =
    options.runtimes ??
    createRuntimeRegistry({
      defaultRuntime: options.defaultRuntime,
    });
  const environment = options.environment ?? createLocalTaskExecutionEnvironment();
  const taskManager =
    options.taskManager ??
    createLocalTaskManager({
      mailbox,
      stateManager,
      runtimes,
      environment,
    });

  return {
    mailbox,
    stateManager,
    taskManager,
    runtimes,
    async run(loop, request) {
      const compiledLoop = compileLoop(loop);
      const handle = await taskManager.startRun(compiledLoop, request);
      return await handle.result;
    },
  };
}

function compileLoop<TInput, TOutput>(
  loop: CompiledLoop<TInput, TOutput> | LoopCompiler<TInput, TOutput>,
): CompiledLoop<TInput, TOutput> {
  return "compile" in loop ? loop.compile() : loop;
}
