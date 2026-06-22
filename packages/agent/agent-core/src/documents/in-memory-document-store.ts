import type {
  ExpertAgentDocumentDeleteInput,
  ExpertAgentDocumentListInput,
  ExpertAgentDocumentMetadata,
  ExpertAgentDocumentReadInput,
  ExpertAgentDocumentResult,
  ExpertAgentDocumentSearchInput,
  ExpertAgentDocumentSearchMatch,
  ExpertAgentDocumentSeed,
  ExpertAgentDocumentStore,
  ExpertAgentDocumentSummary,
  ExpertAgentStoredDocument,
  ExpertAgentStoredDocumentCreateInput,
  ExpertAgentStoredDocumentReadResult,
  ExpertAgentStoredDocumentUpdateInput,
} from "./document-indexer.ts";
import { error, normalizeMetadata, ok } from "./document-indexer.ts";

export type InMemoryDocumentStoreDocumentMap = Readonly<Record<string, string>>;

export interface InMemoryDocumentStoreOptions {
  readonly documents?:
    | readonly ExpertAgentDocumentSeed[]
    | InMemoryDocumentStoreDocumentMap
    | undefined;
  readonly maxDocumentBytes?: number | undefined;
}

export class InMemoryDocumentStore implements ExpertAgentDocumentStore {
  readonly documents = new Map<string, ExpertAgentStoredDocument>();
  readonly maxDocumentBytes: number | undefined;

  constructor(options: InMemoryDocumentStoreOptions = {}) {
    this.maxDocumentBytes = options.maxDocumentBytes;

    for (const document of normalizeSeedDocuments(options.documents)) {
      this.documents.set(document.id, withDocumentRevision(document));
    }
  }

  async listDocuments(
    input: ExpertAgentDocumentListInput = {},
  ): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSummary[]>> {
    void input;

    return ok(
      [...this.documents.values()].map((storedDocument) => ({
        id: storedDocument.id,
        metadata: storedDocument.metadata,
        ...(storedDocument.revision === undefined ? {} : { revision: storedDocument.revision }),
        ...(storedDocument.etag === undefined ? {} : { etag: storedDocument.etag }),
        ...(storedDocument.sizeBytes === undefined ? {} : { sizeBytes: storedDocument.sizeBytes }),
      })),
    );
  }

  async readDocument(
    input: ExpertAgentDocumentReadInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocumentReadResult>> {
    const existing = this.documents.get(input.id);

    if (existing === undefined) {
      return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
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

  async createDocument(
    input: ExpertAgentStoredDocumentCreateInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    const sizeError = validateDocumentSize(input.content, this.maxDocumentBytes);

    if (sizeError !== undefined) {
      return sizeError;
    }

    if (this.documents.has(input.id)) {
      return error("document_already_exists", `Document already exists: ${input.id}`, {
        id: input.id,
      });
    }

    const document = withDocumentRevision({
      id: input.id,
      content: input.content,
      metadata: normalizeMetadata(input.id, normalizeInputMetadata(input.metadata)),
    } satisfies ExpertAgentStoredDocument);
    this.documents.set(input.id, document);

    return ok(document);
  }

  async updateDocument(
    input: ExpertAgentStoredDocumentUpdateInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>> {
    const existing = this.documents.get(input.id);

    if (existing === undefined) {
      return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
    }

    const conflict = validateExpectedRevision(existing, input);

    if (conflict !== undefined) {
      return conflict;
    }

    const content = input.content ?? existing.content;
    const sizeError = validateDocumentSize(content, this.maxDocumentBytes);

    if (sizeError !== undefined) {
      return sizeError;
    }

    const document = withDocumentRevision({
      id: input.id,
      content,
      metadata:
        input.metadata === undefined
          ? existing.metadata
          : normalizeMetadata(input.id, normalizeInputMetadata(input.metadata)),
    } satisfies ExpertAgentStoredDocument);
    this.documents.set(input.id, document);

    return ok(document);
  }

  async deleteDocument(
    input: ExpertAgentDocumentDeleteInput,
  ): Promise<ExpertAgentDocumentResult<{ readonly id: string }>> {
    if (!this.documents.has(input.id)) {
      return error("document_not_found", `Document not found: ${input.id}`, { id: input.id });
    }

    this.documents.delete(input.id);

    return ok({ id: input.id });
  }

  async searchDocuments(
    input: ExpertAgentDocumentSearchInput,
  ): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSearchMatch[]>> {
    const query = input.caseSensitive === true ? input.query : input.query.toLocaleLowerCase();
    const matches: ExpertAgentDocumentSearchMatch[] = [];
    const maxResults = input.maxResults ?? 20;
    const contextLines = input.contextLines ?? 0;

    for (const document of this.documents.values()) {
      const lines = document.content.split("\n");

      for (const [index, line] of lines.entries()) {
        const searchedLine = input.caseSensitive === true ? line : line.toLocaleLowerCase();

        if (!searchedLine.includes(query)) {
          continue;
        }

        matches.push({
          id: document.id,
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
  existing: ExpertAgentStoredDocument,
  input: ExpertAgentStoredDocumentUpdateInput,
): ExpertAgentDocumentResult<never> | undefined {
  if (input.expectedRevision !== undefined && existing.revision !== input.expectedRevision) {
    return error("document_conflict", `Document revision conflict: ${input.id}`, {
      id: input.id,
      expectedRevision: input.expectedRevision,
      actualRevision: existing.revision,
    });
  }

  if (input.expectedEtag !== undefined && existing.etag !== input.expectedEtag) {
    return error("document_conflict", `Document etag conflict: ${input.id}`, {
      id: input.id,
      expectedEtag: input.expectedEtag,
      actualEtag: existing.etag,
    });
  }

  return undefined;
}

function validateDocumentSize(
  content: string,
  maxDocumentBytes: number | undefined,
): ExpertAgentDocumentResult<never> | undefined {
  if (maxDocumentBytes === undefined) {
    return undefined;
  }

  const sizeBytes = Buffer.byteLength(content, "utf8");

  if (sizeBytes <= maxDocumentBytes) {
    return undefined;
  }

  return error("document_too_large", "Document exceeds the configured size limit.", {
    sizeBytes,
    maxDocumentBytes,
  });
}

export function createInMemoryDocumentStore(
  options: InMemoryDocumentStoreOptions = {},
): InMemoryDocumentStore {
  return new InMemoryDocumentStore(options);
}

function normalizeSeedDocuments(
  documents: InMemoryDocumentStoreOptions["documents"],
): readonly ExpertAgentStoredDocument[] {
  if (documents === undefined) {
    return [];
  }

  if (Array.isArray(documents)) {
    return documents.map((document) => withDocumentRevision({
      id: document.id,
      content: document.content,
      metadata: normalizeMetadata(document.id, normalizeInputMetadata(document.metadata)),
    }));
  }

  return Object.entries(documents).map(([id, content]) => withDocumentRevision({
    id,
    content,
    metadata: normalizeMetadata(id, { trigger: "model_decision" }),
  }));
}

function normalizeInputMetadata(
  metadata: Partial<ExpertAgentDocumentMetadata> | undefined,
): ExpertAgentDocumentMetadata {
  return {
    ...(metadata?.description === undefined ? {} : { description: metadata.description }),
    trigger: metadata?.trigger ?? "model_decision",
    ...(metadata?.trustLevel === undefined ? {} : { trustLevel: metadata.trustLevel }),
    ...(metadata?.sensitivity === undefined ? {} : { sensitivity: metadata.sensitivity }),
  };
}

function withDocumentRevision(document: ExpertAgentStoredDocument): ExpertAgentStoredDocument {
  const sizeBytes = Buffer.byteLength(document.content, "utf8");
  const revision = `${sizeBytes}:${hashString(document.content)}`;

  return {
    ...document,
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
