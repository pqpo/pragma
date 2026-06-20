import { createRequire } from "node:module";

import type { ExpertAgentRunContext } from "./run-context.ts";

const require = createRequire(import.meta.url);
const matter = require("gray-matter") as typeof import("gray-matter");

export const AGENTS_DOCUMENT_ID = "AGENTS.md";

export type DocumentTrigger = "always_on" | "model_decision" | "manual";

export type ExpertAgentDocumentErrorCode =
  | "document_not_found"
  | "document_already_exists"
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
}

export interface ExpertAgentDocumentSummary {
  readonly id: string;
  readonly metadata: ExpertAgentDocumentMetadata;
}

export interface ExpertAgentDocument extends ExpertAgentDocumentSummary {
  readonly content: string;
}

export interface ExpertAgentStoredDocumentSummary {
  readonly id: string;
}

export interface ExpertAgentStoredDocument extends ExpertAgentStoredDocumentSummary {
  readonly content: string;
}

export interface ExpertAgentDocumentCreateInput {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentDocumentMetadata> | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentReadInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentListInput {
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentUpdateInput {
  readonly id: string;
  readonly content?: string | undefined;
  readonly metadata?: Partial<ExpertAgentDocumentMetadata> | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentDeleteInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentStoredDocumentCreateInput {
  readonly id: string;
  readonly content: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentStoredDocumentUpdateInput {
  readonly id: string;
  readonly content?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentDocumentStore {
  readonly listDocuments: (
    input: ExpertAgentDocumentListInput
  ) => Promise<ExpertAgentDocumentResult<readonly ExpertAgentStoredDocumentSummary[]>>;
  readonly readDocument: (
    input: ExpertAgentDocumentReadInput
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>>;
  readonly createDocument: (
    input: ExpertAgentStoredDocumentCreateInput
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>>;
  readonly updateDocument: (
    input: ExpertAgentStoredDocumentUpdateInput
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentStoredDocument>>;
  readonly deleteDocument: (
    input: ExpertAgentDocumentDeleteInput
  ) => Promise<ExpertAgentDocumentResult<{ readonly id: string }>>;
}

export interface DocumentIndexerOptions {
  readonly store?: ExpertAgentDocumentStore | undefined;
}

export class DocumentIndexer {
  readonly store: ExpertAgentDocumentStore | undefined;

  #documents: readonly ExpertAgentDocumentSummary[] = [];
  #lastError: ExpertAgentDocumentError | undefined;

  constructor(options: DocumentIndexerOptions = {}) {
    this.store = options.store;
  }

  get documents(): readonly ExpertAgentDocumentSummary[] {
    return this.#documents;
  }

  get lastError(): ExpertAgentDocumentError | undefined {
    return this.#lastError;
  }

  async index(
    context: ExpertAgentRunContext = {}
  ): Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSummary[]>> {
    if (this.store === undefined) {
      this.#documents = [];
      this.#lastError = undefined;
      return ok(this.#documents);
    }

    const listResult = await this.store.listDocuments({ context });

    if (!listResult.ok) {
      this.#lastError = listResult.error;
      return listResult;
    }

    const readResults = await Promise.all(
      listResult.value.map((document) => this.store?.readDocument({ id: document.id, context }))
    );
    const failedRead = readResults.find((result) => result !== undefined && !result.ok);

    if (failedRead !== undefined && !failedRead.ok) {
      this.#lastError = failedRead.error;
      return failedRead;
    }

    this.#documents = readResults
      .filter((result): result is { readonly ok: true; readonly value: ExpertAgentStoredDocument } => {
        return result !== undefined && result.ok;
      })
      .map((result) => parseStoredDocument(result.value))
      .map((document) => normalizeDocumentSummary(document))
      .sort((left, right) => left.id.localeCompare(right.id));
    this.#lastError = undefined;

    return ok(this.#documents);
  }

  async read(input: ExpertAgentDocumentReadInput): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const result = await this.store.readDocument(input);

    if (!result.ok) {
      return result;
    }

    return ok(normalizeDocument(parseStoredDocument(result.value)));
  }

  async create(
    input: ExpertAgentDocumentCreateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const result = await this.store.createDocument({
      id: input.id,
      content: serializeDocument({
        id: input.id,
        content: input.content,
        metadata: normalizeCreateMetadata(input.metadata)
      }),
      context: input.context
    });

    if (!result.ok) {
      return result;
    }

    await this.index(input.context ?? {});

    return ok(normalizeDocument(parseStoredDocument(result.value)));
  }

  async update(
    input: ExpertAgentDocumentUpdateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const existing = await this.store.readDocument({
      id: input.id,
      context: input.context
    });

    if (!existing.ok) {
      return existing;
    }

    const existingDocument = parseStoredDocument(existing.value);
    const metadata = normalizeUpdateMetadata(input.id, existingDocument.metadata, input.metadata);
    const document = normalizeDocument({
      id: input.id,
      content: input.content ?? existingDocument.content,
      metadata
    });
    const result = await this.store.updateDocument({
      id: input.id,
      content: serializeDocument(document),
      context: input.context
    });

    if (!result.ok) {
      return result;
    }

    await this.index(input.context ?? {});

    return ok(normalizeDocument(parseStoredDocument(result.value)));
  }

  async delete(
    input: ExpertAgentDocumentDeleteInput
  ): Promise<ExpertAgentDocumentResult<{ readonly id: string }>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const result = await this.store.deleteDocument(input);

    if (!result.ok) {
      return result;
    }

    await this.index(input.context ?? {});

    return result;
  }

  getByTrigger(trigger: DocumentTrigger): readonly ExpertAgentDocumentSummary[] {
    return this.#documents.filter((document) => document.metadata.trigger === trigger);
  }

  getAlwaysOnDocuments(): readonly ExpertAgentDocumentSummary[] {
    return this.getByTrigger("always_on");
  }

  getManualDocuments(): readonly ExpertAgentDocumentSummary[] {
    return this.getByTrigger("manual");
  }

  getModelDecisionDocuments(): readonly ExpertAgentDocumentSummary[] {
    return this.getByTrigger("model_decision");
  }
}

export function ok<TValue>(value: TValue): ExpertAgentDocumentResult<TValue> {
  return {
    ok: true,
    value
  };
}

export function error<TValue = never>(
  code: ExpertAgentDocumentErrorCode,
  message: string,
  details?: unknown
): ExpertAgentDocumentResult<TValue> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details })
    }
  };
}

export function normalizeDocument(document: ExpertAgentDocument): ExpertAgentDocument {
  return {
    ...normalizeDocumentSummary(document),
    content: document.content
  };
}

export function normalizeDocumentSummary(
  document: ExpertAgentDocumentSummary
): ExpertAgentDocumentSummary {
  return {
    id: document.id,
    metadata: normalizeMetadata(document.id, document.metadata)
  };
}

export function normalizeMetadata(
  id: string,
  metadata: ExpertAgentDocumentMetadata
): ExpertAgentDocumentMetadata {
  if (isAgentsDocumentId(id)) {
    return normalizeAgentsDocumentMetadata(metadata);
  }

  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata.trigger)
  };
}

function normalizeCreateMetadata(
  metadata: Partial<ExpertAgentDocumentMetadata> | undefined
): ExpertAgentDocumentMetadata {
  if (metadata === undefined) {
    return {
      trigger: "model_decision"
    };
  }

  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata.trigger)
  };
}

function normalizeUpdateMetadata(
  id: string,
  existingMetadata: ExpertAgentDocumentMetadata,
  metadata: Partial<ExpertAgentDocumentMetadata> | undefined
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
    trigger: normalizeTrigger(metadata?.trigger ?? existingMetadata.trigger)
  };
}

export function normalizeTrigger(trigger: DocumentTrigger | undefined): DocumentTrigger {
  if (trigger === "always_on" || trigger === "model_decision" || trigger === "manual") {
    return trigger;
  }

  return "model_decision";
}

export function isAgentsDocumentId(id: string): boolean {
  return id === AGENTS_DOCUMENT_ID;
}

function normalizeAgentsDocumentMetadata(
  metadata: ExpertAgentDocumentMetadata
): ExpertAgentDocumentMetadata {
  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: "always_on"
  };
}

function parseStoredDocument(document: ExpertAgentStoredDocument): ExpertAgentDocument {
  const parsed = parseMarkdownDocument(document.content);

  return normalizeDocument({
    id: document.id,
    content: parsed.content,
    metadata: parsed.metadata
  });
}

function parseMarkdownDocument(rawContent: string): {
  readonly metadata: ExpertAgentDocumentMetadata;
  readonly content: string;
} {
  const parsed = matter(rawContent);

  return {
    metadata: parseMatterMetadata(parsed.data),
    content: parsed.content
  };
}

function parseMatterMetadata(data: Record<string, unknown>): ExpertAgentDocumentMetadata {
  const description = data.description;
  const trigger = data.trigger;

  return {
    ...(typeof description === "string" ? { description } : {}),
    trigger: normalizeTrigger(readMetadataTrigger(trigger))
  };
}

function serializeDocument(document: ExpertAgentDocument): string {
  if (isAgentsDocumentId(document.id)) {
    return document.content;
  }

  const serialized = matter.stringify(document.content, {
    ...(document.metadata.description === undefined
      ? {}
      : { description: document.metadata.description }),
    trigger: document.metadata.trigger
  });

  if (!document.content.endsWith("\n") && serialized.endsWith("\n")) {
    return serialized.slice(0, -1);
  }

  return serialized;
}

function readMetadataTrigger(value: unknown): DocumentTrigger | undefined {
  if (value === "always_on" || value === "model_decision" || value === "manual") {
    return value;
  }

  return undefined;
}
