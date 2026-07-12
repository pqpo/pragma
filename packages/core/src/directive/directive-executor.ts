import { randomUUID } from "node:crypto";

import { ExpertAgent } from "../agent/expert-agent.ts";
import type { RuntimeOutputSchema } from "../runtime/runtime-adapter.ts";
import { withExecutionRunScope } from "../runtime/run-context.ts";
import { openRuntimeSession } from "../runtime/session-factory.ts";
import { readRuntimeSessionRecord } from "../runtime/session-record.ts";
import { PragmaPaths } from "../storage/pragma-paths.ts";
import type { Directive, RunResult, StartRunRequest } from "./types.ts";
import { runNestedDirective } from "./directive-execution-context.ts";
import { stringifyInput } from "./utils.ts";

type DirectiveExecutionHandler<TInput = unknown, TOutput = unknown> = (
  request: StartRunRequest<TInput>,
) => Promise<RunResult<TOutput>>;

const directiveExecutionHandlers = new WeakMap<Directive, DirectiveExecutionHandler>();

export function registerDirectiveExecutionHandler<TInput, TOutput>(
  directive: Directive<TInput, TOutput>,
  handler: DirectiveExecutionHandler<TInput, TOutput>,
): void {
  directiveExecutionHandlers.set(directive, handler as DirectiveExecutionHandler<unknown, unknown>);
}

export async function executeDirective<TInput, TOutput>(
  directive: Directive<TInput, TOutput>,
  request: StartRunRequest<TInput>,
): Promise<RunResult<TOutput>> {
  const handler = directiveExecutionHandlers.get(directive) as
    | DirectiveExecutionHandler<TInput, TOutput>
    | undefined;
  if (handler !== undefined) return await handler(request);

  if (directive instanceof ExpertAgent) {
    return await executeExpertAgent<TInput, TOutput>(directive, request);
  }

  if ("steps" in directive) {
    const execution = requireExecution(request);
    return await runNestedDirective(execution, directive, request);
  }

  throw new Error(`Directive ${directive.id} has no registered Core executor.`);
}

function requireExecution<TInput>(request: StartRunRequest<TInput>) {
  if (request.execution === undefined) {
    throw new Error("Directive execution requires a TaskManager execution context.");
  }
  return request.execution;
}

async function executeExpertAgent<TInput, TOutput>(
  agent: ExpertAgent,
  request: StartRunRequest<TInput>,
): Promise<RunResult<TOutput>> {
  const execution = requireExecution(request);
  const runtime = execution.runtimeRegistry.resolve(request.runtime ?? execution.runtimeId);
  const context = withExecutionRunScope(undefined, {
    workflowRunId: execution.workflow.id,
    taskRunId: execution.task.id,
  });
  const systemSessionId =
    request.systemSessionId ?? execution.task.systemSessionId ?? `system-session-${randomUUID()}`;
  let runtimeSession = request.runtimeSession ?? execution.task.runtimeSession;

  if (execution.task.runtimeSessionState === "opened" && runtimeSession === undefined) {
    throw new Error(
      `Runtime Task ${execution.task.id} is missing its persisted RuntimeSessionRef; recovery cannot create a replacement Session.`,
    );
  }
  if (execution.task.runtimeSessionState === "creating" && runtimeSession === undefined) {
    const record = await readRuntimeSessionRecord(
      new PragmaPaths({ pragmaHome: agent.pragmaHome }),
      execution.workflow.id,
      systemSessionId,
    );
    if (record.runtimeSessionRef === null) {
      throw new Error(
        `Runtime Session ${systemSessionId} was interrupted before its native Session was created; recovery cannot create a replacement.`,
      );
    }
    runtimeSession = record.runtimeSessionRef;
  }

  await execution.checkpointRuntimeSession({
    state: runtimeSession === undefined ? "creating" : "opened",
    systemSessionId,
    ...(runtimeSession === undefined ? {} : { runtimeSession }),
  });
  const session = await openRuntimeSession(runtime, {
    agent,
    execution,
    context,
    runtimeSession,
    systemSessionId,
    runtimeSessionOwnerTaskRunId:
      request.runtimeSessionOwnerTaskRunId ??
      execution.task.runtimeSessionOwnerTaskRunId ??
      (runtimeSession === undefined ? undefined : execution.task.id),
    humanInteractionHandler: async (humanRequest) => {
      if (humanRequest.kind === "user_question") {
        const response = await execution.requestHumanInteraction({
          request: {
            kind: "question",
            title: "Agent question",
            questions: humanRequest.questions.map((question) => ({
              ...question,
              options: [...question.options],
            })),
            data: {
              toolName: humanRequest.toolName,
              toolCallId: humanRequest.toolCallId,
            },
          },
        });
        return {
          kind: "user_question",
          answered: true,
          answers: response.answers ?? response.data,
        };
      }

      const response = await execution.requestHumanInteraction({
        request: {
          kind: "approval",
          title: `Approve ${humanRequest.toolName}`,
          ...(humanRequest.reason === undefined ? {} : { prompt: humanRequest.reason }),
          data: {
            toolName: humanRequest.toolName,
            toolCallId: humanRequest.toolCallId,
            input: humanRequest.input,
          },
        },
      });
      return {
        kind: "tool_approval",
        approved: response.approved ?? response.decision === "approved",
        ...(response.notes === undefined ? {} : { reason: response.notes }),
        ...(response.data === undefined ? {} : { updatedInput: response.data }),
      };
    },
  });
  await execution.checkpointRuntimeSession({
    state: "opened",
    systemSessionId: session.info().systemSessionId,
    runtimeSession: session.info().runtimeSession,
  });

  let drainEvents: Promise<void> | undefined;
  let runResult: RunResult<TOutput> | undefined;
  let runError: unknown;
  try {
    const handle = session.submit<TOutput>({
      runId: execution.task.id,
      modelName: request.modelName,
      thinkingLevel: request.thinkingLevel,
      query: stringifyInput(request.input),
      output: request.output as RuntimeOutputSchema<TOutput> | undefined,
    });
    drainEvents = (async () => {
      for await (const event of handle.events) await execution.emitProgress(event);
    })();
    const result = await handle.result;
    await drainEvents;
    runResult = {
      workflowRunId: execution.workflow.id,
      systemSessionId: session.info().systemSessionId,
      output: result.result.output,
      state: execution.state,
      runtimeSession: session.info().runtimeSession,
    };
  } catch (error) {
    runError = error;
  }

  let abortError: unknown;
  try {
    await session.abort();
  } catch (error) {
    abortError = error;
  }
  await drainEvents?.catch(() => undefined);
  if (runError !== undefined) throw runError;
  if (abortError !== undefined) throw abortError;
  if (runResult === undefined) throw new Error("Agent run completed without a result.");
  return runResult;
}
