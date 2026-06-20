import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type {
  AgentLifecycle,
  ExpertAgentRunContext,
  IExpertAgentRunRequest,
  RuntimeAgentSession,
  RuntimeRunRequest,
  RuntimeRunResult,
} from "@expertmesh/agent-core";
import { emitRuntimeStreamEvent } from "@expertmesh/agent-core";

import { readAssistantTextDelta } from "./session-events.ts";
import { createStreamEvent, summarizeInput, summarizeText } from "./stream.ts";
import type { RuntimeStreamBridge } from "./types.ts";

export function createPiRuntimeSession<TInput, TOutput>(
  session: AgentSession,
  outputParser: <TParsedOutput>(text: string) => TParsedOutput,
  lifecycle: AgentLifecycle<ExpertAgentRunContext>,
  streamBridge: RuntimeStreamBridge,
): RuntimeAgentSession<TInput, TOutput> {
  return {
    state: () => lifecycle.state,
    async run(request) {
      return lifecycle.runOnce(request.request.context, async () => {
        const outputTextParts: string[] = [];
        const source = {
          kind: "agent" as const,
          runId: request.invocation.runId,
          path: [],
        };
        streamBridge.runId = request.invocation.runId;
        streamBridge.onEvent = request.onEvent;
        const unsubscribe = session.subscribe((event) => {
          const delta = readAssistantTextDelta(event);

          if (delta !== undefined) {
            outputTextParts.push(delta);
            void emitRuntimeStreamEvent(
              request.onEvent,
              createStreamEvent({
                runId: request.invocation.runId,
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
        });

        try {
          await emitRuntimeStreamEvent(
            request.onEvent,
            createStreamEvent({
              runId: request.invocation.runId,
              source,
              sequence: streamBridge.nextSequence(),
              type: "run.started",
              payload: {
                task: request.request.task,
                inputSummary: summarizeInput(request.request.input),
              },
            }),
          );

          await session.prompt(formatExpertRunPrompt(request.request));
          const outputText = outputTextParts.join("");

          await emitRuntimeStreamEvent(
            request.onEvent,
            createStreamEvent({
              runId: request.invocation.runId,
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
            request.onEvent,
            createStreamEvent({
              runId: request.invocation.runId,
              source,
              sequence: streamBridge.nextSequence(),
              type: "run.completed",
              payload: {
                outputSummary: summarizeText(outputText),
              },
            }),
          );

          return createRuntimeRunResult(request, outputParser<TOutput>(outputText));
        } catch (error) {
          await emitRuntimeStreamEvent(
            request.onEvent,
            createStreamEvent({
              runId: request.invocation.runId,
              source,
              sequence: streamBridge.nextSequence(),
              type: "run.failed",
              payload: {
                message: error instanceof Error ? error.message : "Runtime run failed",
              },
            }),
          );
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

function formatExpertRunPrompt<TInput>(request: IExpertAgentRunRequest<TInput>): string {
  return [
    request.task,
    "",
    "Input:",
    typeof request.input === "string" ? request.input : JSON.stringify(request.input, null, 2),
  ].join("\n");
}

function createRuntimeRunResult<TInput, TOutput>(
  request: RuntimeRunRequest<TInput>,
  output: TOutput,
): RuntimeRunResult<TOutput> {
  return {
    runId: request.invocation.runId,
    result: {
      output,
    },
  };
}
