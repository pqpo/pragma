import type { ExpertAgentRunContext } from "../runtime/run-context.ts";

export const AGENTS_CONTEXT_ID = "AGENTS.md";

export type ContextTrigger = "always_on" | "model_decision" | "manual";
export type ContextTrustLevel = "system" | "workspace" | "user" | "external";
export type ContextSensitivity = "public" | "internal" | "confidential" | "restricted";

export type ExpertAgentContextErrorCode =
  | "context_not_found"
  | "context_already_exists"
  | "context_conflict"
  | "context_too_large"
  | "permission_denied"
  | "invalid_input"
  | "store_unavailable"
  | "store_error";

export interface ExpertAgentContextError {
  readonly code: ExpertAgentContextErrorCode;
  readonly message: string;
  readonly details?: unknown;
}

export type ExpertAgentContextResult<TValue> =
  | {
      readonly ok: true;
      readonly value: TValue;
    }
  | {
      readonly ok: false;
      readonly error: ExpertAgentContextError;
    };

export interface ExpertAgentContextItemMetadata {
  readonly description?: string;
  readonly trigger: ContextTrigger;
  readonly trustLevel?: ContextTrustLevel | undefined;
  readonly sensitivity?: ContextSensitivity | undefined;
}

export interface ExpertAgentContextItemSummary {
  readonly id: string;
  readonly metadata: ExpertAgentContextItemMetadata;
  readonly revision?: string | undefined;
  readonly etag?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface ExpertAgentContextItemContentRange {
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

export interface ExpertAgentContextItem extends ExpertAgentContextItemSummary {
  readonly content: string;
  readonly contentRange?: ExpertAgentContextItemContentRange | undefined;
}

export interface ExpertAgentStoredContextItem {
  readonly id: string;
  readonly content: string;
  readonly metadata: ExpertAgentContextItemMetadata;
  readonly revision?: string | undefined;
  readonly etag?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface ExpertAgentContextItemSeed {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
  readonly revision?: string | undefined;
  readonly etag?: string | undefined;
  readonly sizeBytes?: number | undefined;
}

export interface ExpertAgentStoredContextItemReadResult extends ExpertAgentStoredContextItem {
  readonly contentRange: ExpertAgentContextItemContentRange;
}

export interface ExpertAgentContextRegisterInput {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemReadInput {
  readonly id: string;
  readonly start?: number | undefined;
  readonly offset?: number | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemListInput {
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemUpdateInput {
  readonly id: string;
  readonly content?: string | undefined;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
  readonly expectedRevision?: string | undefined;
  readonly expectedEtag?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemDeleteInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemSearchInput {
  readonly query: string;
  readonly maxResults?: number | undefined;
  readonly contextLines?: number | undefined;
  readonly caseSensitive?: boolean | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemSearchMatch {
  readonly id: string;
  readonly lineNumber: number;
  readonly line: string;
  readonly before?: readonly string[] | undefined;
  readonly after?: readonly string[] | undefined;
}

export interface ExpertAgentStoredContextRegisterInput {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentStoredContextItemUpdateInput {
  readonly id: string;
  readonly content?: string | undefined;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
  readonly expectedRevision?: string | undefined;
  readonly expectedEtag?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextStore {
  readonly listContext: (
    input: ExpertAgentContextItemListInput,
  ) => Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>>;
  readonly readContext: (
    input: ExpertAgentContextItemReadInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>>;
  readonly registerContext: (
    input: ExpertAgentStoredContextRegisterInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>>;
  readonly updateContext: (
    input: ExpertAgentStoredContextItemUpdateInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>>;
  readonly deleteContext: (
    input: ExpertAgentContextItemDeleteInput,
  ) => Promise<ExpertAgentContextResult<{ readonly id: string }>>;
  readonly searchContext: (
    input: ExpertAgentContextItemSearchInput,
  ) => Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>>;
}

export interface ContextSystemOptions {
  readonly store?: ExpertAgentContextStore | undefined;
}

export class ContextSystem {
  readonly store: ExpertAgentContextStore | undefined;

  constructor(options: ContextSystemOptions = {}) {
    this.store = options.store;
  }

  async index(
    context: ExpertAgentRunContext = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    if (this.store === undefined) {
      return ok([]);
    }

    const listResult = await this.store.listContext({ context });

    if (!listResult.ok) {
      return listResult;
    }

    return ok(
      listResult.value
        .map((context) => normalizeContextSummary(context))
        .sort((left, right) => left.id.localeCompare(right.id)),
    );
  }

  async read(
    input: ExpertAgentContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent context store is not configured.");
    }

    const normalizedInput = normalizeReadInput(input);

    if (!normalizedInput.ok) {
      return normalizedInput;
    }

    const result = await this.store.readContext(normalizedInput.value);

    if (!result.ok) {
      return result;
    }

    return ok(normalizeContext(result.value));
  }

  async register(
    input: ExpertAgentContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent context store is not configured.");
    }

    const result = await this.store.registerContext({
      id: input.id,
      content: input.content,
      metadata: normalizeCreateMetadata(input.metadata),
      context: input.context,
    });

    if (!result.ok) {
      return result;
    }

    return ok(normalizeContext(result.value));
  }

  async update(
    input: ExpertAgentContextItemUpdateInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent context store is not configured.");
    }

    const existing = await this.store.readContext({
      id: input.id,
      context: input.context,
    });

    if (!existing.ok) {
      return existing;
    }

    const metadata = normalizeUpdateMetadata(input.id, existing.value.metadata, input.metadata);
    const result = await this.store.updateContext({
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

    return ok(normalizeContext(result.value));
  }

  async delete(
    input: ExpertAgentContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent context store is not configured.");
    }

    const result = await this.store.deleteContext(input);

    if (!result.ok) {
      return result;
    }

    return result;
  }

  async search(
    input: ExpertAgentContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    if (this.store === undefined) {
      return error("store_unavailable", "ExpertAgent context store is not configured.");
    }

    const normalizedInput = normalizeSearchInput(input);

    if (!normalizedInput.ok) {
      return normalizedInput;
    }

    const result = await this.store.searchContext(normalizedInput.value);

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

export function ok<TValue>(value: TValue): ExpertAgentContextResult<TValue> {
  return {
    ok: true,
    value,
  };
}

export function error<TValue = never>(
  code: ExpertAgentContextErrorCode,
  message: string,
  details?: unknown,
): ExpertAgentContextResult<TValue> {
  return {
    ok: false,
    error: {
      code,
      message,
      ...(details === undefined ? {} : { details }),
    },
  };
}

export function normalizeContext(context: ExpertAgentContextItem): ExpertAgentContextItem {
  return {
    ...normalizeContextSummary(context),
    content: context.content,
    ...(context.contentRange === undefined
      ? {}
      : { contentRange: normalizeContentRange(context.contentRange) }),
  };
}

export function normalizeContextSummary(
  context: ExpertAgentContextItemSummary,
): ExpertAgentContextItemSummary {
  return {
    id: context.id,
    metadata: normalizeMetadata(context.id, context.metadata),
    ...(context.revision === undefined ? {} : { revision: context.revision }),
    ...(context.etag === undefined ? {} : { etag: context.etag }),
    ...(context.sizeBytes === undefined ? {} : { sizeBytes: context.sizeBytes }),
  };
}

export function normalizeMetadata(
  id: string,
  metadata: ExpertAgentContextItemMetadata,
): ExpertAgentContextItemMetadata {
  if (isAgentsContextId(id)) {
    return normalizeAgentsContextMetadata(metadata);
  }

  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata.trigger),
    ...(metadata.trustLevel === undefined
      ? {}
      : { trustLevel: normalizeTrustLevel(metadata.trustLevel) }),
    ...(metadata.sensitivity === undefined
      ? {}
      : { sensitivity: normalizeSensitivity(metadata.sensitivity) }),
  };
}

function normalizeCreateMetadata(
  metadata: Partial<ExpertAgentContextItemMetadata> | undefined,
): ExpertAgentContextItemMetadata {
  if (metadata === undefined) {
    return {
      trigger: "model_decision",
    };
  }

  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata.trigger),
    ...(metadata.trustLevel === undefined
      ? {}
      : { trustLevel: normalizeTrustLevel(metadata.trustLevel) }),
    ...(metadata.sensitivity === undefined
      ? {}
      : { sensitivity: normalizeSensitivity(metadata.sensitivity) }),
  };
}

function normalizeUpdateMetadata(
  id: string,
  existingMetadata: ExpertAgentContextItemMetadata,
  metadata: Partial<ExpertAgentContextItemMetadata> | undefined,
): ExpertAgentContextItemMetadata {
  if (isAgentsContextId(id)) {
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

export function normalizeTrigger(trigger: ContextTrigger | undefined): ContextTrigger {
  if (trigger === "always_on" || trigger === "model_decision" || trigger === "manual") {
    return trigger;
  }

  return "model_decision";
}

export function normalizeSearchInput(
  input: ExpertAgentContextItemSearchInput,
): ExpertAgentContextResult<ExpertAgentContextItemSearchInput> {
  const query = input.query.trim();

  if (query.length === 0) {
    return error("invalid_input", "Context search query must not be empty.");
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
  match: ExpertAgentContextItemSearchMatch,
): ExpertAgentContextItemSearchMatch {
  return {
    id: match.id,
    lineNumber: Math.max(1, Math.trunc(match.lineNumber)),
    line: match.line,
    ...(match.before === undefined ? {} : { before: [...match.before] }),
    ...(match.after === undefined ? {} : { after: [...match.after] }),
  };
}

export function normalizeReadInput(
  input: ExpertAgentContextItemReadInput,
): ExpertAgentContextResult<ExpertAgentContextItemReadInput> {
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

export function isAgentsContextId(id: string): boolean {
  return id === AGENTS_CONTEXT_ID;
}

function normalizeAgentsContextMetadata(
  metadata: ExpertAgentContextItemMetadata,
): ExpertAgentContextItemMetadata {
  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: "always_on",
  };
}

function normalizeContentRange(
  range: ExpertAgentContextItemContentRange,
): ExpertAgentContextItemContentRange {
  const startOffset = Math.max(0, Math.trunc(range.startOffset));
  const endOffset = Math.max(startOffset, Math.trunc(range.endOffset));
  const nextStartOffset = Math.max(endOffset, Math.trunc(range.nextStartOffset));

  return {
    requestedStartOffset: Math.max(0, Math.trunc(range.requestedStartOffset)),
    startOffset,
    endOffset,
    nextStartOffset,
    truncated: range.truncated,
    ...(range.sizeBytes === undefined
      ? {}
      : { sizeBytes: Math.max(0, Math.trunc(range.sizeBytes)) }),
    ...(range.maxBytes === undefined ? {} : { maxBytes: Math.max(0, Math.trunc(range.maxBytes)) }),
    ...(range.startLine === undefined
      ? {}
      : { startLine: Math.max(1, Math.trunc(range.startLine)) }),
    ...(range.endLine === undefined ? {} : { endLine: Math.max(1, Math.trunc(range.endLine)) }),
    ...(range.totalLines === undefined
      ? {}
      : { totalLines: Math.max(1, Math.trunc(range.totalLines)) }),
  };
}

function normalizeOptionalNonNegativeInteger(
  value: number | undefined,
  key: string,
): ExpertAgentContextResult<number | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (!Number.isFinite(value) || value < 0) {
    return error("invalid_input", `Context read parameter "${key}" must be a non-negative number.`);
  }

  return ok(Math.trunc(value));
}

function normalizeOptionalPositiveInteger(
  value: number | undefined,
  key: string,
): ExpertAgentContextResult<number | undefined> {
  if (value === undefined) {
    return ok(undefined);
  }

  if (!Number.isFinite(value) || value <= 0) {
    return error("invalid_input", `Context read parameter "${key}" must be a positive number.`);
  }

  return ok(Math.trunc(value));
}

function normalizeTrustLevel(value: string | undefined): ContextTrustLevel {
  if (value === "system" || value === "workspace" || value === "user" || value === "external") {
    return value;
  }

  return "workspace";
}

function normalizeSensitivity(value: string | undefined): ContextSensitivity {
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
