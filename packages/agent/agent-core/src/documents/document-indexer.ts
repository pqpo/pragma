import type { ExpertAgentRunContext } from "../runtime/run-context.ts";

export const AGENTS_DOCUMENT_ID = "AGENTS.md";

export type DocumentTrigger = "always_on" | "model_decision" | "manual";
export type DocumentTrustLevel = "system" | "workspace" | "user" | "external";
export type DocumentSensitivity = "public" | "internal" | "confidential" | "restricted";

export type ExpertAgentDocumentErrorCode =
  | "document_not_found"
  | "document_already_exists"
  | "document_conflict"
  | "document_too_large"
  | "permission_denied"
  | "invalid_input"
  | "store_unavailable"
  | "store_error";

export interface ExpertAgentDocumentError {
  readonly code: ExpertAgentDocumentErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export type ExpertAgentDocumentResult<TValue> =
  | {
      readonly ok: true;
      readonly value: TValue;
    }
  | {
      readonly ok: false;
      readonly error: ExpertAgentDocumentError;
    };

export interface ExpertAgentDocumentMetadata {
  readonly description?: string;
  readonly trigger: DocumentTrigger;
  readonly trustLevel?: DocumentTrustLevel | undefined;
  readonly sensitivity?: DocumentSensitivity | undefined;
}

export interface ExpertAgentDocumentSummary {
  readonly id: string;
  readonly metadata: ExpertAgentDocumentMetadata;
  readonly revision?: string | undefined;
  readonly etag?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface ExpertAgentDocumentContentRange {
  readonly requestedStartOffset: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly nextStartOffset: number;
  readonly truncated: boolean;
  readonly sizeBytes?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly startLine?: number | undefined;
  readonly endLine?: number | undefined;
  readonly totalLines?: number | undefined;
}

export interface ExpertAgentDocument extends ExpertAgentDocumentSummary {
  readonly content: string;
  readonly contentRange?: ExpertAgentDocumentContentRange | undefined;
}

export interface ExpertAgentStoredDocument {
  readonly id: string;
  readonly content: string;
  readonly metadata: ExpertAgentDocumentMetadata;
  readonly revision?: string | undefined;
  readonly etag?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface ExpertAgentDocumentSeed {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentDocumentMetadata> | undefined;
  readonly revision?: string | undefined;
  readonly etag?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface ExpertAgentStoredDocumentReadResult extends ExpertAgentStoredDocument {
  readonly contentRange: ExpertAgentDocumentContentRange;
}

export interface ExpertAgentDocumentCreateInput {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentDocumentMetadata> | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentReadInput {
  readonly id: string;
  readonly start?: number | undefined;
  readonly offset?: number | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentListInput {
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentUpdateInput {
  readonly id: string;
  readonly content?: string | undefined;
  readonly metadata?: Partial<ExpertAgentDocumentMetadata> | undefined;
  readonly expectedRevision?: string | undefined;
  readonly expectedEtag?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentDeleteInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentSearchInput {
  readonly query: string;
  readonly maxResults?: number | undefined;
  readonly contextLines?: number | undefined;
  readonly caseSensitive?: boolean | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentSearchMatch {
  readonly id: string;
  readonly lineNumber: number;
  readonly line: string;
  readonly before?: readonly string[] | undefined;
  readonly after?: readonly string[] | undefined;
}

export interface ExpertAgentStoredDocumentCreateInput {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentDocumentMetadata> | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentStoredDocumentUpdateInput {
  readonly id: string;
  readonly content?: string | undefined;
  readonly metadata?: Partial<ExpertAgentDocumentMetadata> | undefined;
  readonly expectedRevision?: string | undefined;
  readonly expectedEtag?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentStore {
  readonly listDocuments: (
    input: ExpertAgentDocumentListInput,
  ) => Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSummary[]>>;
  readonly readDocument: (
    input: ExpertAgentDocumentReadInput,
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocumentReadResult>>;
  readonly createDocument: (
    input: ExpertAgentStoredDocumentCreateInput,
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>>;
  readonly updateDocument: (
    input: ExpertAgentStoredDocumentUpdateInput,
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>>;
  readonly deleteDocument: (
    input: ExpertAgentDocumentDeleteInput,
  ) => Promise<ExpertAgentDocumentResult<{ readonly id: string }>>;
  readonly searchDocuments: (
    input: ExpertAgentDocumentSearchInput,
  ) => Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSearchMatch[]>>;
}

export interface DocumentIndexerOptions {
  readonly store?: ExpertAgentDocumentStore | undefined;
}

export class DocumentIndexer {
  readonly store: ExpertAgentDocumentStore | undefined;

  constructor(options: DocumentIndexerOptions = {}) {
    this.store = options.store;
  }

  async index(
    context: ExpertAgentRunContext = {},
  ): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSummary[]>> {
    if (this.store === undefined) {
      return ok([]);
    }

    const listResult = await this.store.listDocuments({ context });

    if (!listResult.ok) {
      return listResult;
    }

    return ok(
      listResult.value
        .map((document) => normalizeDocumentSummary(document))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  async read(
    input: ExpertAgentDocumentReadInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const normalizedInput = normalizeReadInput(input);

    if (!normalizedInput.ok) {
      return normalizedInput;
    }

    const result = await this.store.readDocument(normalizedInput.value);

    if (!result.ok) {
      return result;
    }

    return ok(normalizeDocument(result.value));
  }

  async create(
    input: ExpertAgentDocumentCreateInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const result = await this.store.createDocument({
      id: input.id,
      content: input.content,
      metadata: normalizeCreateMetadata(input.metadata),
      context: input.context,
    });

    if (!result.ok) {
      return result;
    }

    return ok(normalizeDocument(result.value));
  }

  async update(
    input: ExpertAgentDocumentUpdateInput,
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const existing = await this.store.readDocument({
      id: input.id,
      context: input.context,
    });

    if (!existing.ok) {
      return existing;
    }

    const metadata = normalizeUpdateMetadata(input.id, existing.value.metadata, input.metadata);
    const result = await this.store.updateDocument({
      id: input.id,
      content: input.content,
      metadata,
      expectedRevision: input.expectedRevision,
      expectedEtag: input.expectedEtag,
      context: input.context,
    });

    if (!result.ok) {
      return result;
    }

    return ok(normalizeDocument(result.value));
  }

  async delete(
    input: ExpertAgentDocumentDeleteInput,
  ): Promise<ExpertAgentDocumentResult<{ readonly id: string }>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const result = await this.store.deleteDocument(input);

    if (!result.ok) {
      return result;
    }

    return result;
  }

  async search(
    input: ExpertAgentDocumentSearchInput,
  ): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSearchMatch[]>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const normalizedInput = normalizeSearchInput(input);

    if (!normalizedInput.ok) {
      return normalizedInput;
    }

    const result = await this.store.searchDocuments(normalizedInput.value);

    if (!result.ok) {
      return result;
    }

    return ok(
      result.value.map(normalizeSearchMatch).sort((left, right) => {
        const idComparison = left.id.localeCompare(right.id);

        if (idComparison !== 0) {
          return idComparison;
        }

        return left.lineNumber - right.lineNumber;
      }),
    );
  }
}

export function ok<TValue>(value: TValue): ExpertAgentDocumentResult<TValue> {
  return {
    ok: true,
    value,
  };
}

export function error<TValue = never>(
  code: ExpertAgentDocumentErrorCode,
  message: string,
  details?: unknown,
): ExpertAgentDocumentResult<TValue> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function normalizeDocument(document: ExpertAgentDocument): ExpertAgentDocument {
  return {
    ...normalizeDocumentSummary(document),
    content: document.content,
    ...(document.contentRange === undefined
      ? {}
      : { contentRange: normalizeContentRange(document.contentRange) }),
  };
}

export function normalizeDocumentSummary(
  document: ExpertAgentDocumentSummary,
): ExpertAgentDocumentSummary {
  return {
    id: document.id,
    metadata: normalizeMetadata(document.id, document.metadata),
    ...(document.revision === undefined ? {} : { revision: document.revision }),
    ...(document.etag === undefined ? {} : { etag: document.etag }),
    ...(document.sizeBytes === undefined ? {} : { sizeBytes: document.sizeBytes }),
  };
}

export function normalizeMetadata(
  id: string,
  metadata: ExpertAgentDocumentMetadata,
): ExpertAgentDocumentMetadata {
  if (isAgentsDocumentId(id)) {
    return normalizeAgentsDocumentMetadata(metadata);
  }

  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata.trigger),
    ...(metadata.trustLevel === undefined ? {} : { trustLevel: normalizeTrustLevel(metadata.trustLevel) }),
    ...(metadata.sensitivity === undefined
      ? {}
      : { sensitivity: normalizeSensitivity(metadata.sensitivity) }),
  };
}

function normalizeCreateMetadata(
  metadata: Partial<ExpertAgentDocumentMetadata> | undefined,
): ExpertAgentDocumentMetadata {
  if (metadata === undefined) {
    return {
      trigger: "model_decision",
    };
  }

  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata.trigger),
    ...(metadata.trustLevel === undefined ? {} : { trustLevel: normalizeTrustLevel(metadata.trustLevel) }),
    ...(metadata.sensitivity === undefined
      ? {}
      : { sensitivity: normalizeSensitivity(metadata.sensitivity) }),
  };
}

function normalizeUpdateMetadata(
  id: string,
  existingMetadata: ExpertAgentDocumentMetadata,
  metadata: Partial<ExpertAgentDocumentMetadata> | undefined,
): ExpertAgentDocumentMetadata {
  if (isAgentsDocumentId(id)) {
    return existingMetadata;
  }

  return {
    ...(metadata?.description === undefined
      ? existingMetadata.description === undefined
        ? {}
        : { description: existingMetadata.description }
      : { description: metadata.description }),
    trigger: normalizeTrigger(metadata?.trigger ?? existingMetadata.trigger),
    ...(metadata?.trustLevel === undefined
      ? existingMetadata.trustLevel === undefined
        ? {}
        : { trustLevel: existingMetadata.trustLevel }
      : { trustLevel: normalizeTrustLevel(metadata.trustLevel) }),
    ...(metadata?.sensitivity === undefined
      ? existingMetadata.sensitivity === undefined
        ? {}
        : { sensitivity: existingMetadata.sensitivity }
      : { sensitivity: normalizeSensitivity(metadata.sensitivity) }),
  };
}

export function normalizeTrigger(trigger: DocumentTrigger | undefined): DocumentTrigger {
  if (trigger === "always_on" || trigger === "model_decision" || trigger === "manual") {
    return trigger;
  }

  return "model_decision";
}

export function normalizeSearchInput(
  input: ExpertAgentDocumentSearchInput,
): ExpertAgentDocumentResult<ExpertAgentDocumentSearchInput> {
  const query = input.query.trim();

  if (query.length === 0) {
    return error("invalid_input", "Document search query must not be empty.");
  }

  return ok({
    query,
    maxResults: clampInteger(input.maxResults, 1, 50, 20),
    contextLines: clampInteger(input.contextLines, 0, 5, 0),
    caseSensitive: input.caseSensitive ?? false,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}

export function normalizeSearchMatch(
  match: ExpertAgentDocumentSearchMatch,
): ExpertAgentDocumentSearchMatch {
  return {
    id: match.id,
    lineNumber: Math.max(1, Math.trunc(match.lineNumber)),
    line: match.line,
    ...(match.before === undefined ? {} : { before: [...match.before] }),
    ...(match.after === undefined ? {} : { after: [...match.after] }),
  };
}

export function normalizeReadInput(
  input: ExpertAgentDocumentReadInput,
): ExpertAgentDocumentResult<ExpertAgentDocumentReadInput> {
  const start = normalizeOptionalNonNegativeInteger(input.start, "start");

  if (!start.ok) {
    return start;
  }

  const offset = normalizeOptionalPositiveInteger(input.offset, "offset");

  if (!offset.ok) {
    return offset;
  }

  return ok({
    id: input.id,
    ...(start.value === undefined ? {} : { start: start.value }),
    ...(offset.value === undefined ? {} : { offset: offset.value }),
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}

export function isAgentsDocumentId(id: string): boolean {
  return id === AGENTS_DOCUMENT_ID;
}

function normalizeAgentsDocumentMetadata(
  metadata: ExpertAgentDocumentMetadata,
): ExpertAgentDocumentMetadata {
  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: "always_on",
  };
}

function normalizeContentRange(
  range: ExpertAgentDocumentContentRange,
): ExpertAgentDocumentContentRange {
  const startOffset = Math.max(0, Math.trunc(range.startOffset));
  const endOffset = Math.max(startOffset, Math.trunc(range.endOffset));
  const nextStartOffset = Math.max(endOffset, Math.trunc(range.nextStartOffset));

  return {
    requestedStartOffset: Math.max(0, Math.trunc(range.requestedStartOffset)),
    startOffset,
    endOffset,
    nextStartOffset,
    truncated: range.truncated,
    ...(range.sizeBytes === undefined ? {} : { sizeBytes: Math.max(0, Math.trunc(range.sizeBytes)) }),
    ...(range.maxBytes === undefined ? {} : { maxBytes: Math.max(0, Math.trunc(range.maxBytes)) }),
    ...(range.startLine === undefined ? {} : { startLine: Math.max(1, Math.trunc(range.startLine)) }),
    ...(range.endLine === undefined ? {} : { endLine: Math.max(1, Math.trunc(range.endLine)) }),
    ...(range.totalLines === undefined ? {} : { totalLines: Math.max(1, Math.trunc(range.totalLines)) }),
  };
}

function normalizeOptionalNonNegativeInteger(
  value: number | undefined,
  key: string,
): ExpertAgentDocumentResult<number | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (!Number.isFinite(value) || value < 0) {
    return error("invalid_input", `Document read parameter "${key}" must be a non-negative number.`);
  }

  return ok(Math.trunc(value));
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
  key: string,
): ExpertAgentDocumentResult<number | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (!Number.isFinite(value) || value <= 0) {
    return error("invalid_input", `Document read parameter "${key}" must be a positive number.`);
  }

  return ok(Math.trunc(value));
}

function normalizeTrustLevel(value: string | undefined): DocumentTrustLevel {
  if (value === "system" || value === "workspace" || value === "user" || value === "external") {
    return value;
  }

  return "workspace";
}

function normalizeSensitivity(value: string | undefined): DocumentSensitivity {
  if (
    value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "restricted"
  ) {
    return value;
  }

  return "internal";
}

function clampInteger(
  value: number | undefined,
  min: number,
  max: number,
  fallback: number,
): number {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, Math.trunc(value as number)));
}
