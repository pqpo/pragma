import type { AgentSession, ModelRegistry } from "@earendil-works/pi-coding-agent";
import { AgentMessageUsageSchema, type AgentMessageUsage } from "@pragma/shared";
import type {
  AgentLifecycle,
  ExpertAgent,
  ExpertAgentRunContext,
  RuntimeAgentSession,
  RuntimeOutputSchema,
  RuntimeRunResult,
  RuntimeSessionInfo,
  RuntimeStreamEvent,
  RuntimeSubmitRequest,
} from "@pragma/core";
import {
  AsyncPushQueue,
  createRuntimeEventEmitter,
  dispatchExpertAgentHook,
} from "@pragma/core";
import { randomUUID } from "node:crypto";

import {
  readAssistantMessageText,
  readAssistantTextDelta,
  readAssistantThinkingDelta,
  readProgressEvent,
  readToolExecutionEvent,
} from "./session-events.ts";
import { convertPiAgentMessages } from "./session-messages.ts";
import { createToolStreamEvents, summarizeInput, summarizeText } from "./stream.ts";
import { resolveRequiredRuntimeModel } from "./models.ts";
import type { PiRuntimeStreamState } from "./types.ts";

const DEFAULT_OUTPUT_RETRY_LIMIT = 3;

export function createPiRuntimeSession(
  agent: ExpertAgent,
  session: AgentSession,
  info: Omit<RuntimeSessionInfo, "sessionState" | "runState">,
  outputParser: <TParsedOutput>(text: string) => TParsedOutput,
  lifecycle: AgentLifecycle<ExpertAgentRunContext | undefined>,
  streamState: PiRuntimeStreamState,
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
    submit<TSubmitOutput = string>(submission: RuntimeSubmitRequest<TSubmitOutput>) {
      const runId = submission.runId ?? randomUUID();
      const queue = new AsyncPushQueue<RuntimeStreamEvent>();
      const emitter = createRuntimeEventEmitter(queue);
      const logger = streamState.logger ?? agent.logger;
      let cancelled = false;
      let preflightRejected = false;

      const result = lifecycle.enqueue(async ({ signal }) => {
        let outputText: string;
        const source = {
          kind: "agent" as const,
          runId,
          path: [],
        };
        streamState.runId = runId;
        streamState.emitter = emitter;
        streamState.source = source;
        logger.info("Runtime run submitted", {
          runId,
          modelName: submission.modelName,
          hasOutputSchema: submission.output !== undefined,
        });
        const unsubscribe = session.subscribe((event) => {
          const delta = readAssistantTextDelta(event);
          const thinkingDelta = readAssistantThinkingDelta(event);
          const completedMessageText = readAssistantMessageText(event);
          const progressEvent = readProgressEvent(event);
          const toolEvent = readToolExecutionEvent(event);

          if (delta !== undefined) {
            emitter.emit({
              runId,
              source,
              type: "message.delta",
              payload: {
                role: "assistant",
                contentType: "text",
                delta,
              },
            });
          }

          if (thinkingDelta !== undefined) {
            emitter.emit({
              runId,
              source,
              type: "thought.delta",
              payload: {
                contentType: "text",
                delta: thinkingDelta,
              },
            });
          }

          if (completedMessageText !== undefined) {
            outputText = completedMessageText;
            emitter.emit({
              runId,
              source,
              type: "message.completed",
              payload: {
                role: "assistant",
                contentType: "text",
                text: completedMessageText,
              },
            });
          }

          if (progressEvent !== undefined) {
            emitter.emit({
              runId,
              source,
              type: "progress",
              payload: progressEvent,
            });
          }

          if (toolEvent !== undefined) {
            for (const streamEvent of createToolStreamEvents({
              runId,
              source,
              toolEvent,
            })) {
              emitter.emit(streamEvent);
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
            context: lifecycle.currentContext,
            logger,
          });

          emitter.emit({
            runId,
            source,
            type: "run.started",
            payload: {
              task: submission.query,
              inputSummary: summarizeInput(submission.query),
            },
          });

          const messageCountBeforeRun = session.messages.length;
          const outputRetryLimit = normalizeOutputRetryLimit(
            submission.outputRetryLimit ?? options.outputRetryLimit,
          );
          const maxAttempts = submission.output === undefined ? 1 : outputRetryLimit + 1;
          let parseResult: ParseRuntimeOutputResult<TSubmitOutput> | undefined;

          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            outputText = "";
            await session.prompt(
              attempt === 1
                ? createInitialPrompt(submission.query, submission.output)
                : createOutputRetryPrompt(parseResult),
              {
                preflightResult: (success) => {
                  if (!success) {
                    preflightRejected = true;
                  }
                },
              },
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

          const usage = aggregateAssistantUsage(session.messages.slice(messageCountBeforeRun));
          const result = createRuntimeRunResult(runId, parseResult.value, usage);

          emitter.emit({
            runId,
            source,
            type: "run.completed",
            payload: {
              ...(usage === undefined ? {} : { usage }),
            },
          });

          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: createSessionInfo(info, lifecycle),
            runId,
            submission,
            result,
            context: lifecycle.currentContext,
            logger,
          });
          logger.info("Runtime run completed", {
            runId,
            usage,
          });

          return result;
        } catch (error) {
          const wasCancelled = signal.aborted || cancelled;
          const message = preflightRejected
            ? "Runtime prompt preflight rejected the submission."
            : error instanceof Error
              ? error.message
              : "Runtime run failed";

          emitter.emit({
            runId,
            source,
            type: wasCancelled ? "run.cancelled" : "run.failed",
            payload: wasCancelled
              ? {
                  reason: "cancelled",
                }
              : {
                  message,
                },
          });
          await dispatchExpertAgentHook(agent.hooks, "afterTaskSubmit", {
            agent,
            session: createSessionInfo(info, lifecycle),
            runId,
            submission,
            error,
            context: lifecycle.currentContext,
            logger,
          });
          logger[wasCancelled ? "warn" : "error"](
            wasCancelled ? "Runtime run cancelled" : "Runtime run failed",
            {
              runId,
              message,
              error,
            },
          );
          throw error;
        } finally {
          streamState.runId = undefined;
          streamState.emitter = undefined;
          streamState.source = undefined;
          unsubscribe();
          emitter.complete();
        }
      });

      return {
        runId,
        events: queue,
        result,
        async cancel() {
          cancelled = true;
          await lifecycle.abort();
        },
      };
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
  usage: AgentMessageUsage | undefined,
): RuntimeRunResult<TOutput> {
  return {
    runId,
    result: {
      output,
      ...(usage === undefined ? {} : { usage }),
    },
  };
}

function aggregateAssistantUsage(messages: readonly unknown[]): AgentMessageUsage | undefined {
  const usages = messages
    .map((message) => readAssistantUsage(message))
    .filter((usage): usage is AgentMessageUsage => usage !== undefined);

  if (usages.length === 0) {
    return undefined;
  }

  return usages.reduce<AgentMessageUsage>(
    (total, usage) => ({
      input: total.input + usage.input,
      output: total.output + usage.output,
      cacheRead: total.cacheRead + usage.cacheRead,
      cacheWrite: total.cacheWrite + usage.cacheWrite,
      ...(total.cacheWrite1h === undefined && usage.cacheWrite1h === undefined
        ? {}
        : { cacheWrite1h: (total.cacheWrite1h ?? 0) + (usage.cacheWrite1h ?? 0) }),
      totalTokens: total.totalTokens + usage.totalTokens,
      cost: {
        input: total.cost.input + usage.cost.input,
        output: total.cost.output + usage.cost.output,
        cacheRead: total.cost.cacheRead + usage.cost.cacheRead,
        cacheWrite: total.cost.cacheWrite + usage.cost.cacheWrite,
        total: total.cost.total + usage.cost.total,
      },
    }),
    createEmptyUsage(),
  );
}

function readAssistantUsage(message: unknown): AgentMessageUsage | undefined {
  if (!isRecord(message) || message["role"] !== "assistant") {
    return undefined;
  }

  const result = AgentMessageUsageSchema.safeParse(message["usage"]);
  return result.success ? result.data : undefined;
}

function createEmptyUsage(): AgentMessageUsage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
