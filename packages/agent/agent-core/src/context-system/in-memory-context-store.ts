import type {
  ExpertAgentContextItemDeleteInput,
  ExpertAgentContextItemListInput,
  ExpertAgentContextItemMetadata,
  ExpertAgentContextItemReadInput,
  ExpertAgentContextResult,
  ExpertAgentContextItemSearchInput,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSeed,
  ExpertAgentContextStore,
  ExpertAgentContextItemSummary,
  ExpertAgentStoredContextItem,
  ExpertAgentStoredContextRegisterInput,
  ExpertAgentStoredContextItemReadResult,
  ExpertAgentStoredContextItemUpdateInput,
} from "./context-system.ts";
import { error, normalizeMetadata, ok } from "./context-system.ts";

export type InMemoryContextStoreContextMap = Readonly<Record<string, string>>;

export interface InMemoryContextStoreOptions {
  readonly context?:
    | readonly ExpertAgentContextItemSeed[]
    | InMemoryContextStoreContextMap
    | undefined;
  readonly maxContextBytes?: number | undefined;
}

export class InMemoryContextStore implements ExpertAgentContextStore {
  readonly context = new Map<string, ExpertAgentStoredContextItem>();
  readonly maxContextBytes: number | undefined;

  constructor(options: InMemoryContextStoreOptions = {}) {
    this.maxContextBytes = options.maxContextBytes;

    for (const context of normalizeSeedContexts(options.context)) {
      this.context.set(context.id, withContextRevision(context));
    }
  }

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    void input;

    return ok(
      [...this.context.values()].map((storedContext) => ({
        id: storedContext.id,
        metadata: storedContext.metadata,
        ...(storedContext.revision === undefined ? {} : { revision: storedContext.revision }),
        ...(storedContext.etag === undefined ? {} : { etag: storedContext.etag }),
        ...(storedContext.sizeBytes === undefined ? {} : { sizeBytes: storedContext.sizeBytes }),
      })),
    );
  }

  async readContext(
    input: ExpertAgentContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    const existing = this.context.get(input.id);

    if (existing === undefined) {
      return error("context_not_found", `Context not found: ${input.id}`, { id: input.id });
    }

    const content = existing.content;
    const buffer = Buffer.from(content, "utf8");
    const sizeBytes = buffer.byteLength;
    const requestedStartOffset = Math.min(sizeBytes, Math.max(0, Math.trunc(input.start ?? 0)));
    const requestedEndOffset =
      input.offset === undefined
        ? sizeBytes
        : Math.min(sizeBytes, requestedStartOffset + Math.max(0, Math.trunc(input.offset)));
    const decoded = decodeUtf8Range(buffer.subarray(requestedStartOffset, requestedEndOffset));
    const startOffset = requestedStartOffset + decoded.startIndex;
    const endOffset = requestedStartOffset + decoded.endIndex;
    const lineRange = calculateLineRange(content, startOffset, endOffset);

    return ok({
      ...existing,
      content: decoded.content,
      contentRange: {
        requestedStartOffset,
        startOffset,
        endOffset,
        nextStartOffset: endOffset,
        truncated: endOffset < sizeBytes,
        sizeBytes,
        ...(input.offset === undefined ? {} : { maxBytes: Math.max(1, Math.trunc(input.offset)) }),
        startLine: lineRange.startLine,
        endLine: lineRange.endLine,
        totalLines: lineRange.totalLines,
      },
    });
  }

  async registerContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    const sizeError = validateContextSize(input.content, this.maxContextBytes);

    if (sizeError !== undefined) {
      return sizeError;
    }

    if (this.context.has(input.id)) {
      return error("context_already_exists", `Context already exists: ${input.id}`, {
        id: input.id,
      });
    }

    const context = withContextRevision({
      id: input.id,
      content: input.content,
      metadata: normalizeMetadata(input.id, normalizeInputMetadata(input.metadata)),
    } satisfies ExpertAgentStoredContextItem);
    this.context.set(input.id, context);

    return ok(context);
  }

  async updateContext(
    input: ExpertAgentStoredContextItemUpdateInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    const existing = this.context.get(input.id);

    if (existing === undefined) {
      return error("context_not_found", `Context not found: ${input.id}`, { id: input.id });
    }

    const conflict = validateExpectedRevision(existing, input);

    if (conflict !== undefined) {
      return conflict;
    }

    const content = input.content ?? existing.content;
    const sizeError = validateContextSize(content, this.maxContextBytes);

    if (sizeError !== undefined) {
      return sizeError;
    }

    const context = withContextRevision({
      id: input.id,
      content,
      metadata:
        input.metadata === undefined
          ? existing.metadata
          : normalizeMetadata(input.id, normalizeInputMetadata(input.metadata)),
    } satisfies ExpertAgentStoredContextItem);
    this.context.set(input.id, context);

    return ok(context);
  }

  async deleteContext(
    input: ExpertAgentContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    if (!this.context.has(input.id)) {
      return error("context_not_found", `Context not found: ${input.id}`, { id: input.id });
    }

    this.context.delete(input.id);

    return ok({ id: input.id });
  }

  async searchContext(
    input: ExpertAgentContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const query = input.caseSensitive === true ? input.query : input.query.toLocaleLowerCase();
    const matches: ExpertAgentContextItemSearchMatch[] = [];
    const maxResults = input.maxResults ?? 20;
    const contextLines = input.contextLines ?? 0;

    for (const context of this.context.values()) {
      const lines = context.content.split("\n");

      for (const [index, line] of lines.entries()) {
        const searchedLine = input.caseSensitive === true ? line : line.toLocaleLowerCase();

        if (!searchedLine.includes(query)) {
          continue;
        }

        matches.push({
          id: context.id,
          lineNumber: index + 1,
          line: trimLineEnd(line),
          before: readContextLines(lines, index - contextLines, index),
          after: readContextLines(lines, index + 1, index + 1 + contextLines),
        });

        if (matches.length >= maxResults) {
          return ok(matches);
        }
      }
    }

    return ok(matches);
  }
}

function validateExpectedRevision(
  existing: ExpertAgentStoredContextItem,
  input: ExpertAgentStoredContextItemUpdateInput,
): ExpertAgentContextResult<never> | undefined {
  if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
    return error("context_conflict", `Context revision conflict: ${input.id}`, {
      id: input.id,
      expectedRevision: input.expectedRevision,
      actualRevision: existing.revision,
    });
  }

  if (input.expectedEtag !== undefined && existing.etag !== input.expectedEtag) {
    return error("context_conflict", `Context etag conflict: ${input.id}`, {
      id: input.id,
      expectedEtag: input.expectedEtag,
      actualEtag: existing.etag,
    });
  }

  return undefined;
}

function validateContextSize(
  content: string,
  maxContextBytes: number | undefined,
): ExpertAgentContextResult<never> | undefined {
  if (maxContextBytes === undefined) {
    return undefined;
  }

  const sizeBytes = Buffer.byteLength(content, "utf8");

  if (sizeBytes <= maxContextBytes) {
    return undefined;
  }

  return error("context_too_large", "Context exceeds the configured size limit.", {
    sizeBytes,
    maxContextBytes,
  });
}

export function createInMemoryContextStore(
  options: InMemoryContextStoreOptions = {},
): InMemoryContextStore {
  return new InMemoryContextStore(options);
}

function normalizeSeedContexts(
  context: InMemoryContextStoreOptions["context"],
): readonly ExpertAgentStoredContextItem[] {
  if (context === undefined) {
    return [];
  }

  if (Array.isArray(context)) {
    return context.map((context) =>
      withContextRevision({
        id: context.id,
        content: context.content,
        metadata: normalizeMetadata(context.id, normalizeInputMetadata(context.metadata)),
      }),
    );
  }

  return Object.entries(context).map(([id, content]) =>
    withContextRevision({
      id,
      content,
      metadata: normalizeMetadata(id, { trigger: "model_decision" }),
    }),
  );
}

function normalizeInputMetadata(
  metadata: Partial<ExpertAgentContextItemMetadata> | undefined,
): ExpertAgentContextItemMetadata {
  return {
    ...(metadata?.description === undefined ? {} : { description: metadata.description }),
    trigger: metadata?.trigger ?? "model_decision",
    ...(metadata?.trustLevel === undefined ? {} : { trustLevel: metadata.trustLevel }),
    ...(metadata?.sensitivity === undefined ? {} : { sensitivity: metadata.sensitivity }),
  };
}

function withContextRevision(context: ExpertAgentStoredContextItem): ExpertAgentStoredContextItem {
  const sizeBytes = Buffer.byteLength(context.content, "utf8");
  const revision = `${sizeBytes}:${hashString(context.content)}`;

  return {
    ...context,
    revision,
    etag: revision,
    sizeBytes,
  };
}

function hashString(value: string): string {
  let hash = 0;

  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }

  return hash.toString(16);
}

function readContextLines(
  lines: readonly string[],
  start: number,
  end: number,
): readonly string[] | undefined {
  const context = lines.slice(Math.max(0, start), Math.max(0, end)).map(trimLineEnd);

  return context.length === 0 ? undefined : context;
}

function trimLineEnd(line: string): string {
  return line.replace(/\r?\n$/, "");
}

function calculateLineRange(
  content: string,
  startOffset: number,
  endOffset: number,
): {
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
} {
  const fullBuffer = Buffer.from(content, "utf8");
  const prefix = fullBuffer.subarray(0, startOffset).toString("utf8");
  const range = fullBuffer.subarray(startOffset, endOffset).toString("utf8");
  const startLine = countLines(prefix);

  return {
    startLine,
    endLine: range.length === 0 ? startLine : startLine + countNewlines(range),
    totalLines: countLines(content),
  };
}

function countLines(content: string): number {
  return countNewlines(content) + 1;
}

function countNewlines(content: string): number {
  return content.split("\n").length - 1;
}

function decodeUtf8Range(buffer: Buffer): {
  readonly content: string;
  readonly startIndex: number;
  readonly endIndex: number;
} {
  let startIndex = 0;
  let endIndex = buffer.length;

  while (startIndex < endIndex && isUtf8ContinuationByte(buffer[startIndex] ?? 0)) {
    startIndex += 1;
  }

  while (endIndex > startIndex) {
    try {
      return {
        content: new TextDecoder("utf-8", { fatal: true }).decode(
          buffer.subarray(startIndex, endIndex),
        ),
        startIndex,
        endIndex,
      };
    } catch {
      endIndex -= 1;
    }
  }

  return {
    content: "",
    startIndex,
    endIndex: startIndex,
  };
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}
