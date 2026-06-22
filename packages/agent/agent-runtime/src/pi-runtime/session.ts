import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import type {
  AgentLifecycle,
  ExpertAgent,
  RuntimeAgentSession,
  RuntimeOutputSchema,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeSubmitRequest,
} from "@expertmesh/agent-core";
import { createRuntimeEventDispatcher, dispatchExpertAgentHook } from "@expertmesh/agent-core";
import { randomUUID } from "node:crypto";

import { readAssistantTextDelta, readToolExecutionEvent } from "./session-events.ts";
import { convertPiAgentMessages } from "./session-messages.ts";
import {
  createStreamEvent,
  createToolStreamEvents,
  summarizeInput,
  summarizeText,
} from "./stream.ts";
import { resolveRequiredRuntimeModel } from "./models.ts";
import type { RuntimeStreamBridge } from "./types.ts";

const DEFAULT_OUTPUT_RETRY_LIMIT = 3;

export function createPiRuntimeSession(
  agent: ExpertAgent,
  session: AgentSession,
  info: Omit<RuntimeSessionInfo, "sessionState" | "runState">,
  outputParser: <TParsedOutput>(text: string) => TParsedOutput,
  lifecycle: AgentLifecycle,
  streamBridge: RuntimeStreamBridge,
  models: {
    readonly defaultModelName?: string | undefined;
    readonly modelRegistry: ModelRegistry;
  },
  options: {
    readonly outputRetryLimit?: number | undefined;
  } = {},
): RuntimeAgentSession {
  return {
    info: () => createSessionInfo(info, lifecycle),
    messages: () => convertPiAgentMessages(session.messages),
    async submit<TSubmitOutput = string>(submission: RuntimeSubmitRequest<TSubmitOutput>) {
      return await lifecycle.enqueue(async ({ signal }) => {
        const runId = submission.runId ?? randomUUID();
        let outputTextParts: string[] = [];
        const source = {
          kind: "agent" as const,
          runId,
          path: [],
        };
        streamBridge.runId = runId;
        streamBridge.onEvent = submission.onEvent;
        const dispatcher = createRuntimeEventDispatcher({
          sink: submission.onEvent,
        });
        const unsubscribe = session.subscribe((event) => {
          const delta = readAssistantTextDelta(event);
          const toolEvent = readToolExecutionEvent(event);

          if (delta !== undefined) {
            outputTextParts.push(delta);
            dispatcher.dispatch(
              createStreamEvent({
                runId,
                source,
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
              sequence: dispatcher.nextSequence,
              toolEvent,
            })) {
              dispatcher.dispatch(streamEvent);
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
            session: createSessionInfo(info, lifecycle),
            runId,
            submission,
          });

          await dispatcher.emit(
            createStreamEvent({
              runId,
              source,
              type: "run.started",
              payload: {
                task: submission.query,
                inputSummary: summarizeInput(submission.query),
              },
            }),
          );

          const outputRetryLimit = normalizeOutputRetryLimit(
            submission.outputRetryLimit ?? options.outputRetryLimit,
          );
          const maxAttempts = submission.output === undefined ? 1 : outputRetryLimit + 1;
          let parseResult: ParseRuntimeOutputResult<TSubmitOutput> | undefined;
          let outputText = "";

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            outputTextParts = [];
            await session.prompt(
              attempt === 1
                ? createInitialPrompt(submission.query, submission.output)
                : createOutputRetryPrompt(parseResult),
            );
            await dispatcher.drain();
            outputText = outputTextParts.join("");

            await dispatcher.emit(
              createStreamEvent({
                runId,
                source,
                type: "message.completed",
                payload: {
                  role: "assistant",
                  contentType: "text",
                  text: outputText,
                },
              }),
            );

            parseResult = parseRuntimeOutput(outputText, submission.output, outputParser);

            if (parseResult.ok) {
              break;
            }

            if (attempt === maxAttempts) {
              throw parseResult.error;
            }
          }

          if (parseResult === undefined || !parseResult.ok) {
            throw new Error("Runtime output parsing did not complete");
          }

          const result = createRuntimeRunResult(runId, parseResult.value);

          await dispatcher.emit(
            createStreamEvent({
              runId,
              source,
              type: "run.completed",
              payload: {
                outputSummary: summarizeText(outputText),
              },
            }),
          );

          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: createSessionInfo(info, lifecycle),
            runId,
            submission,
            result,
          });

          return result;
        } catch (error) {
          const wasCancelled = signal.aborted;

          await dispatcher.emit(
            createStreamEvent({
              runId,
              source,
              type: wasCancelled ? "run.aborted" : "run.failed",
              payload: wasCancelled
                ? {
                    reason: "cancelled",
                  }
                : {
                    message: error instanceof Error ? error.message : "Runtime run failed",
                  },
            }),
          );
          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: createSessionInfo(info, lifecycle),
            runId,
            submission,
            error,
          });
          throw error;
        } finally {
          await dispatcher.drain();
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

function createSessionInfo(
  info: Omit<RuntimeSessionInfo, "sessionState" | "runState">,
  lifecycle: AgentLifecycle,
): RuntimeSessionInfo {
  return {
    ...info,
    sessionState: lifecycle.sessionState,
    runState: lifecycle.runState,
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
): ParseRuntimeOutputResult<TOutput> {
  try {
    if (output === undefined) {
      return { ok: true, value: defaultParser<TOutput>(text) };
    }

    const jsonParseResult = tryParseJsonLike(text);
    if (jsonParseResult.ok) {
      return { ok: true, value: output.parse(jsonParseResult.value) };
    }

    return { ok: true, value: output.parse(text) };
  } catch (error) {
    return {
      ok: false,
      error: toRuntimeOutputParseError(error, text),
    };
  }
}

type ParseRuntimeOutputResult<TOutput> =
  | { readonly ok: true; readonly value: TOutput }
  | { readonly ok: false; readonly error: Error };

function createInitialPrompt(
  query: string,
  output: RuntimeOutputSchema<unknown> | undefined,
): string {
  if (output === undefined) {
    return query;
  }

  return `${query}

Return the final answer as valid JSON only. Do not include Markdown fences, prose, comments, or any characters before or after the JSON value. The JSON value must satisfy the requested output schema.`;
}

function createOutputRetryPrompt(
  parseResult: ParseRuntimeOutputResult<unknown> | undefined,
): string {
  const message =
    parseResult !== undefined && !parseResult.ok
      ? parseResult.error.message
      : "The previous response could not be parsed.";

  return `The previous response did not satisfy the required JSON output format.

Parser error:
${message}

Reply again with valid JSON only. Do not include Markdown fences, prose, comments, or any characters before or after the JSON value.`;
}

function normalizeOutputRetryLimit(value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_OUTPUT_RETRY_LIMIT;
  }

  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_OUTPUT_RETRY_LIMIT;
  }

  return Math.trunc(value);
}

function toRuntimeOutputParseError(error: unknown, text: string): Error {
  const message = error instanceof Error ? error.message : "Runtime output parsing failed";

  return new Error(`${message}\nRaw output:\n${summarizeText(text)}`, {
    cause: error,
  });
}

function tryParseJsonLike(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  const candidates = createJsonCandidates(text);

  for (const candidate of candidates) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      continue;
    }
  }

  return { ok: false };
}

function createJsonCandidates(text: string): string[] {
  const trimmed = text.trim();
  const candidates: string[] = [];
  addJsonCandidate(candidates, trimmed);

  for (const fenced of extractFencedCodeBlocks(trimmed)) {
    addJsonCandidate(candidates, fenced.trim());
  }

  const balanced = extractBalancedJsonValue(trimmed);
  if (balanced !== undefined) {
    addJsonCandidate(candidates, balanced);
  }

  return candidates;
}

function addJsonCandidate(candidates: string[], candidate: string): void {
  if (candidate.length > 0 && !candidates.includes(candidate)) {
    candidates.push(candidate);
  }
}

function extractFencedCodeBlocks(text: string): string[] {
  const blocks: string[] = [];
  const fencePattern = /```(?:json|JSON)?\s*([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(text)) !== null) {
    blocks.push(match[1] ?? "");
  }

  return blocks;
}

function extractBalancedJsonValue(text: string): string | undefined {
  for (let start = 0; start < text.length; start++) {
    const opening = text[start];
    if (opening !== "{" && opening !== "[") {
      continue;
    }

    const extracted = readBalancedJsonFrom(text, start);
    if (extracted !== undefined) {
      return extracted;
    }
  }

  return undefined;
}

function readBalancedJsonFrom(text: string, start: number): string | undefined {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;

  for (let index = start; index < text.length; index++) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
      continue;
    }

    if (char === "{" || char === "[") {
      stack.push(char);
      continue;
    }

    if (char !== "}" && char !== "]") {
      continue;
    }

    const opening = stack.pop();
    if ((char === "}" && opening !== "{") || (char === "]" && opening !== "[")) {
      return undefined;
    }

    if (stack.length === 0) {
      return text.slice(start, index + 1);
    }
  }

  return undefined;
}
