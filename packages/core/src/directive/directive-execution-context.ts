import type { Directive, DirectiveExecutionContext, RunResult, StartRunRequest } from "./types.ts";

const directiveRunner = Symbol("pragma.directive-runner");

export type InternalDirectiveRunner = <TInput, TOutput>(
  directive: Directive<TInput, TOutput>,
  request: StartRunRequest<TInput>,
) => Promise<RunResult<TOutput>>;

type InternalDirectiveExecutionContext = DirectiveExecutionContext & {
  readonly [directiveRunner]: InternalDirectiveRunner;
};

export function attachDirectiveRunner(
  context: DirectiveExecutionContext,
  runner: InternalDirectiveRunner,
): DirectiveExecutionContext {
  return Object.assign(context, { [directiveRunner]: runner });
}

export async function runNestedDirective<TInput, TOutput>(
  context: DirectiveExecutionContext,
  directive: Directive<TInput, TOutput>,
  request: StartRunRequest<TInput>,
): Promise<RunResult<TOutput>> {
  const runner = (context as InternalDirectiveExecutionContext)[directiveRunner];
  if (runner === undefined) {
    throw new Error("No internal directive runner is configured for nested execution.");
  }
  return await runner(directive, request);
}
