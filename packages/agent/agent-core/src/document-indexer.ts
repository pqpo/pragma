import type { ExpertAgentRunContext } from "./run-context.ts";

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

export interface ExpertAgentDocumentStore {
  readonly listDocuments: (
    input: ExpertAgentDocumentListInput
  ) => Promise<ExpertAgentDocumentResult<readonly ExpertAgentDocumentSummary[]>>;
  readonly readDocument: (
    input: ExpertAgentDocumentReadInput
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentDocument>>;
  readonly createDocument: (
    input: ExpertAgentDocumentCreateInput
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentDocument>>;
  readonly updateDocument: (
    input: ExpertAgentDocumentUpdateInput
  ) => Promise<ExpertAgentDocumentResult<ExpertAgentDocument>>;
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

    const result = await this.store.listDocuments({ context });

    if (!result.ok) {
      this.#lastError = result.error;
      return result;
    }

    this.#documents = result.value
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

    return ok(normalizeDocument(result.value));
  }

  async create(
    input: ExpertAgentDocumentCreateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const result = await this.store.createDocument({
      ...input,
      metadata: normalizeCreateMetadata(input.metadata)
    });

    if (!result.ok) {
      return result;
    }

    await this.index(input.context ?? {});

    return ok(normalizeDocument(result.value));
  }

  async update(
    input: ExpertAgentDocumentUpdateInput
  ): Promise<ExpertAgentDocumentResult<ExpertAgentDocument>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent document store is not configured.");
    }

    const result = await this.store.updateDocument({
      ...input,
      metadata:
        input.metadata === undefined ? undefined : normalizeUpdateMetadata(input.metadata)
    });

    if (!result.ok) {
      return result;
    }

    await this.index(input.context ?? {});

    return ok(normalizeDocument(result.value));
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
    metadata: normalizeMetadata(document.metadata)
  };
}

export function normalizeMetadata(
  metadata: ExpertAgentDocumentMetadata
): ExpertAgentDocumentMetadata {
  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata.trigger)
  };
}

function normalizeCreateMetadata(
  metadata: Partial<ExpertAgentDocumentMetadata> | undefined
): Partial<ExpertAgentDocumentMetadata> {
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
  metadata: Partial<ExpertAgentDocumentMetadata>
): Partial<ExpertAgentDocumentMetadata> {
  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    ...(metadata.trigger === undefined ? {} : { trigger: normalizeTrigger(metadata.trigger) })
  };
}

export function normalizeTrigger(trigger: DocumentTrigger | undefined): DocumentTrigger {
  if (trigger === "always_on" || trigger === "model_decision" || trigger === "manual") {
    return trigger;
  }

  return "model_decision";
}
