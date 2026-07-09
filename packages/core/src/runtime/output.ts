import type { AgentMessageUsage } from "@pragma/shared";

import type { IExpertAgentRunResult } from "../agent/expert-agent.ts";
import type { RuntimeOutputSchema, RuntimeRunResult } from "./runtime-adapter.ts";

const DEFAULT_OUTPUT_RETRY_LIMIT = 1;
const JSON_OUTPUT_INSTRUCTION =
  "Return the final answer as valid JSON only. Do not include Markdown fences, prose, comments, or any characters before or after the JSON value. The JSON value must satisfy the requested output schema.";

export type RuntimeOutputParser = <TOutput>(text: string) => TOutput;

export type RuntimeOutputParseResult<TOutput> =
  | { readonly ok: true; readonly value: TOutput }
  | { readonly ok: false; readonly error: Error };

export function createRuntimeRunResult<TOutput>(
  runId: string,
  output: TOutput,
  usage: AgentMessageUsage | undefined,
): RuntimeRunResult<TOutput> {
  return {
    runId,
    result: createExpertAgentRunResult(output, usage),
  };
}

export function createExpertAgentRunResult<TOutput>(
  output: TOutput,
  usage: AgentMessageUsage | undefined,
): IExpertAgentRunResult<TOutput> {
  return {
    output,
    ...(usage === undefined ? {} : { usage }),
  };
}

export function parseRuntimeOutput<TOutput>(
  text: string,
  output: RuntimeOutputSchema<TOutput> | undefined,
  defaultParser: RuntimeOutputParser = defaultRuntimeOutputParser,
): RuntimeOutputParseResult<TOutput> {
  try {
    if (output === undefined) {
      return { ok: true, value: defaultParser<TOutput>(text) };
    }

    const jsonParseResult = tryParseJsonLike(text);
    return { ok: true, value: output.parse(jsonParseResult.ok ? jsonParseResult.value : text) };
  } catch (error) {
    return {
      ok: false,
      error: createRuntimeOutputParseError(error, text),
    };
  }
}

export function createInitialRuntimePrompt(
  query: string,
  output: RuntimeOutputSchema<unknown> | undefined,
): string {
  const prompt = output === undefined ? query : `${query}\n\n${JSON_OUTPUT_INSTRUCTION}`;
  return prompt;
}

export function createRuntimeOutputRetryPrompt(
  parseResult: RuntimeOutputParseResult<unknown> | undefined,
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

export function normalizeOutputRetryLimit(
  value: number | undefined,
  defaultValue = DEFAULT_OUTPUT_RETRY_LIMIT,
): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return defaultValue;
  }

  return Math.trunc(value);
}

export function summarizeRuntimeInput(input: unknown, maxLength = 160): string {
  const text = typeof input === "string" ? input : (JSON.stringify(input) ?? String(input));
  const compact = text.replace(/\s+/g, " ").trim();
  return summarizeRuntimeText(compact, maxLength);
}

export function summarizeRuntimeText(text: string, maxLength = 240): string {
  return text.length <= maxLength ? text : `${text.slice(0, Math.max(maxLength - 3, 0))}...`;
}

export function tryParseJsonLike(
  text: string,
): { readonly ok: true; readonly value: unknown } | { readonly ok: false } {
  for (const candidate of createJsonCandidates(text)) {
    try {
      return { ok: true, value: JSON.parse(candidate) as unknown };
    } catch {
      continue;
    }
  }

  return { ok: false };
}

function defaultRuntimeOutputParser<TOutput>(text: string): TOutput {
  return text as TOutput;
}

function createRuntimeOutputParseError(error: unknown, text: string): Error {
  const message = error instanceof Error ? error.message : "Runtime output parsing failed";

  return new Error(`${message}\nRaw output:\n${summarizeRuntimeText(text)}`, {
    cause: error,
  });
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
