import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  AgentLifecycle,
  ExpertAgent,
  RuntimeAgentSession,
  RuntimeOutputSchema,
  RuntimeRunResult,
  RuntimeSessionInfo,
} from "@expertmesh/agent-core";
import { dispatchExpertAgentHook, emitRuntimeStreamEvent } from "@expertmesh/agent-core";
import { randomUUID } from "node:crypto";

import { readAssistantTextDelta, readToolExecutionEvent } from "./session-events.ts";
import {
  createStreamEvent,
  createToolStreamEvents,
  summarizeInput,
  summarizeText,
} from "./stream.ts";
import { resolveRequiredRuntimeModel } from "./models.ts";
import type { RuntimeStreamBridge } from "./types.ts";

export function createPiRuntimeSession<TOutput>(
  agent: ExpertAgent,
  session: AgentSession,
  info: Omit<RuntimeSessionInfo, "state">,
  outputParser: <TParsedOutput>(text: string) => TParsedOutput,
  lifecycle: AgentLifecycle,
  streamBridge: RuntimeStreamBridge,
  models: {
    readonly defaultModelName?: string | undefined;
    readonly modelRegistry: ModelRegistry;
  },
): RuntimeAgentSession<TOutput> {
  return {
    info: () => ({
      ...info,
      state: lifecycle.state,
    }),
    state: () => lifecycle.state,
    async submit(submission) {
      return await lifecycle.enqueue(async () => {
        const runId = submission.runId ?? randomUUID();
        const outputTextParts: string[] = [];
        const source = {
          kind: "agent" as const,
          runId,
          path: [],
        };
        streamBridge.runId = runId;
        streamBridge.onEvent = submission.onEvent;
        const unsubscribe = session.subscribe((event) => {
          const delta = readAssistantTextDelta(event);
          const toolEvent = readToolExecutionEvent(event);

          if (delta !== undefined) {
            outputTextParts.push(delta);
            void emitRuntimeStreamEvent(
              submission.onEvent,
              createStreamEvent({
                runId,
                source,
                sequence: streamBridge.nextSequence(),
                type: "message.delta",
                payload: {
                  role: "assistant",
                  contentType: "text",
                  delta,
                },
              }),
            );
          }

          if (toolEvent !== undefined) {
            for (const streamEvent of createToolStreamEvents({
              runId,
              source,
              sequence: streamBridge.nextSequence,
              toolEvent,
            })) {
              void emitRuntimeStreamEvent(submission.onEvent, streamEvent);
            }
          }
        });

        try {
          await applySubmissionModel(
            session,
            models.modelRegistry,
            submission.modelName ?? models.defaultModelName,
          );

          await dispatchExpertAgentHook(agent.hooks, "beforeTaskSubmit", {
            agent,
            session: {
              ...info,
              state: lifecycle.state,
            },
            runId,
            submission,
          });

          await emitRuntimeStreamEvent(
            submission.onEvent,
            createStreamEvent({
              runId,
              source,
              sequence: streamBridge.nextSequence(),
              type: "run.started",
              payload: {
                task: submission.query,
                inputSummary: summarizeInput(submission.query),
              },
            }),
          );

          await session.prompt(submission.query);
          const outputText = outputTextParts.join("");

          await emitRuntimeStreamEvent(
            submission.onEvent,
            createStreamEvent({
              runId,
              source,
              sequence: streamBridge.nextSequence(),
              type: "message.completed",
              payload: {
                role: "assistant",
                contentType: "text",
                text: outputText,
              },
            }),
          );

          await emitRuntimeStreamEvent(
            submission.onEvent,
            createStreamEvent({
              runId,
              source,
              sequence: streamBridge.nextSequence(),
              type: "run.completed",
              payload: {
                outputSummary: summarizeText(outputText),
              },
            }),
          );

          const result = createRuntimeRunResult(
            runId,
            parseRuntimeOutput(outputText, submission.output, outputParser),
          );

          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: {
              ...info,
              state: lifecycle.state,
            },
            runId,
            submission,
            result,
          });

          return result;
        } catch (error) {
          await emitRuntimeStreamEvent(
            submission.onEvent,
            createStreamEvent({
              runId,
              source,
              sequence: streamBridge.nextSequence(),
              type: "run.failed",
              payload: {
                message: error instanceof Error ? error.message : "Runtime run failed",
              },
            }),
          );
          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: {
              ...info,
              state: lifecycle.state,
            },
            runId,
            submission,
            error,
          });
          throw error;
        } finally {
          streamBridge.runId = undefined;
          streamBridge.onEvent = undefined;
          unsubscribe();
        }
      });
    },
    async abort() {
      await lifecycle.abort();
    },
  };
}

async function applySubmissionModel(
  session: AgentSession,
  modelRegistry: ModelRegistry,
  modelName: string | undefined,
): Promise<void> {
  const model = resolveRequiredRuntimeModel(modelName, modelRegistry, "submission");

  if (
    model === undefined ||
    (session.model?.provider === model.provider && session.model.id === model.id)
  ) {
    return;
  }

  await session.setModel(model);
}

function createRuntimeRunResult<TOutput>(
  runId: string,
  output: TOutput,
): RuntimeRunResult<TOutput> {
  return {
    runId,
    result: {
      output,
    },
  };
}

function parseRuntimeOutput<TOutput>(
  text: string,
  output: RuntimeOutputSchema<TOutput> | undefined,
  defaultParser: <TParsedOutput>(text: string) => TParsedOutput,
): TOutput {
  if (output === undefined) {
    return defaultParser<TOutput>(text);
  }

  const jsonParseResult = tryParseJson(text);
  if (jsonParseResult.ok) {
    return output.parse(jsonParseResult.value);
  }

  return output.parse(text);
}

function tryParseJson(text: string):
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}
