import type { ExpertAgentRunContext } from "../runtime/run-context.ts";

export const AGENTS_CONTEXT_ID = "AGENTS.md";
export const HOST_CONTEXT_NAMESPACE = "host";

export type ContextTrigger = "always_on" | "model_decision" | "manual";
export type ContextTrustLevel = "system" | "workspace" | "user" | "external";
export type ContextSensitivity = "public" | "internal" | "confidential" | "restricted";

export interface ExpertAgentContextItemReference {
  readonly namespace?: string | undefined;
  readonly id: string;
}

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
  readonly namespace?: string | undefined;
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

export interface ExpertAgentContextStoreRegistrationInput {
  readonly namespace: string;
  readonly store: ExpertAgentContextStore;
}

export interface ExpertAgentContextStoreRegistration {
  readonly namespace: string;
}

export interface ExpertAgentContextAddInput {
  readonly namespace: string;
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemReadInput {
  readonly namespace: string;
  readonly id: string;
  readonly start?: number | undefined;
  readonly offset?: number | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentStoredContextItemReadInput {
  readonly id: string;
  readonly start?: number | undefined;
  readonly offset?: number | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemListInput {
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemUpdateInput {
  readonly namespace: string;
  readonly id: string;
  readonly content?: string | undefined;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
  readonly expectedRevision?: string | undefined;
  readonly expectedEtag?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemDeleteInput {
  readonly namespace: string;
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentStoredContextItemDeleteInput {
  readonly id: string;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemDeleteResult {
  readonly namespace?: string | undefined;
  readonly id: string;
}

export interface ExpertAgentContextItemSearchInput {
  readonly namespace?: string | undefined;
  readonly query: string;
  readonly maxResults?: number | undefined;
  readonly contextLines?: number | undefined;
  readonly caseSensitive?: boolean | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemSearchMatch {
  readonly namespace?: string | undefined;
  readonly id: string;
  readonly lineNumber: number;
  readonly line: string;
  readonly before?: readonly string[] | undefined;
  readonly after?: readonly string[] | undefined;
}

export interface ExpertAgentStoredContextItemSearchInput {
  readonly query: string;
  readonly maxResults?: number | undefined;
  readonly contextLines?: number | undefined;
  readonly caseSensitive?: boolean | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
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
    input: ExpertAgentStoredContextItemReadInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>>;
  readonly addContext: (
    input: ExpertAgentStoredContextRegisterInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>>;
  readonly updateContext: (
    input: ExpertAgentStoredContextItemUpdateInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>>;
  readonly deleteContext: (
    input: ExpertAgentStoredContextItemDeleteInput,
  ) => Promise<ExpertAgentContextResult<{ readonly id: string }>>;
  readonly searchContext: (
    input: ExpertAgentStoredContextItemSearchInput,
  ) => Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>>;
}

export interface ContextSystemOptions {
  readonly store?: ExpertAgentContextStore | undefined;
  readonly stores?:
    | ReadonlyMap<string, ExpertAgentContextStore>
    | Readonly<Record<string, ExpertAgentContextStore>>
    | readonly (readonly [string, ExpertAgentContextStore])[]
    | undefined;
}

export class ContextSystem {
  readonly stores = new Map<string, ExpertAgentContextStore>();

  constructor(options: ContextSystemOptions = {}) {
    if (options.store !== undefined) {
      this.stores.set(HOST_CONTEXT_NAMESPACE, options.store);
    }

    for (const [namespace, store] of normalizeStoreEntries(options.stores)) {
      this.stores.set(namespace, store);
    }
  }

  register(
    input: ExpertAgentContextStoreRegistrationInput,
  ): ExpertAgentContextResult<ExpertAgentContextStoreRegistration> {
    const namespaceResult = normalizeNamespace(input.namespace);

    if (!namespaceResult.ok) {
      return namespaceResult;
    }

    if (this.stores.has(namespaceResult.value)) {
      return error("context_already_exists", `Context store already exists: ${namespaceResult.value}`, {
        namespace: namespaceResult.value,
      });
    }

    this.stores.set(namespaceResult.value, input.store);

    return ok({ namespace: namespaceResult.value });
  }

  async index(
    context: ExpertAgentRunContext = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    if (this.stores.size === 0) {
      return ok([]);
    }

    const summaries: ExpertAgentContextItemSummary[] = [];

    for (const [namespace, store] of this.stores) {
      const listResult = await store.listContext({ context });

      if (!listResult.ok) {
        return listResult;
      }

      summaries.push(
        ...listResult.value.map((context) => normalizeContextSummary(context, namespace)),
      );
    }

    return ok(
      summaries.sort((left, right) => {
        const namespaceComparison = (left.namespace ?? "").localeCompare(right.namespace ?? "");

        if (namespaceComparison !== 0) {
          return namespaceComparison;
        }

        return left.id.localeCompare(right.id);
      }),
    );
  }

  async read(
    input: ExpertAgentContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    const normalizedInput = normalizeReadInput(input);

    if (!normalizedInput.ok) {
      return normalizedInput;
    }

    const storeResult = this.getStore(normalizedInput.value.namespace);

    if (!storeResult.ok) {
      return storeResult;
    }

    const result = await storeResult.value.readContext(stripNamespace(normalizedInput.value));

    if (!result.ok) {
      return result;
    }

    return ok(normalizeContext(result.value, normalizedInput.value.namespace));
  }

  async add(
    input: ExpertAgentContextAddInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    const namespaceResult = normalizeNamespace(input.namespace);

    if (!namespaceResult.ok) {
      return namespaceResult;
    }

    const storeResult = this.getStore(namespaceResult.value);

    if (!storeResult.ok) {
      return storeResult;
    }

    const result = await storeResult.value.addContext({
      id: input.id,
      content: input.content,
      metadata: normalizeCreateMetadata(input.metadata),
      context: input.context,
    });

    if (!result.ok) {
      return result;
    }

    return ok(normalizeContext(result.value, namespaceResult.value));
  }

  async update(
    input: ExpertAgentContextItemUpdateInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItem>> {
    const namespaceResult = normalizeNamespace(input.namespace);

    if (!namespaceResult.ok) {
      return namespaceResult;
    }

    const storeResult = this.getStore(namespaceResult.value);

    if (!storeResult.ok) {
      return storeResult;
    }

    const existing = await storeResult.value.readContext({
      id: input.id,
      context: input.context,
    });

    if (!existing.ok) {
      return existing;
    }

    const metadata = normalizeUpdateMetadata(input.id, existing.value.metadata, input.metadata);
    const result = await storeResult.value.updateContext({
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

    return ok(normalizeContext(result.value, namespaceResult.value));
  }

  async delete(
    input: ExpertAgentContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItemDeleteResult>> {
    const namespaceResult = normalizeNamespace(input.namespace);

    if (!namespaceResult.ok) {
      return namespaceResult;
    }

    const storeResult = this.getStore(namespaceResult.value);

    if (!storeResult.ok) {
      return storeResult;
    }

    const result = await storeResult.value.deleteContext(stripNamespace(input));

    if (!result.ok) {
      return result;
    }

    return ok({ namespace: namespaceResult.value, id: result.value.id });
  }

  async search(
    input: ExpertAgentContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const normalizedInput = normalizeSearchInput(input);

    if (!normalizedInput.ok) {
      return normalizedInput;
    }

    const matches: ExpertAgentContextItemSearchMatch[] = [];
    const storesResult = this.getSearchStores(normalizedInput.value.namespace);

    if (!storesResult.ok) {
      return storesResult;
    }

    for (const [namespace, store] of storesResult.value) {
      const result = await store.searchContext(stripNamespace(normalizedInput.value));

      if (!result.ok) {
        return result;
      }

      matches.push(...result.value.map((match) => normalizeSearchMatch(match, namespace)));

    }

    return ok(
      matches.sort((left, right) => {
        const namespaceComparison = (left.namespace ?? "").localeCompare(right.namespace ?? "");

        if (namespaceComparison !== 0) {
          return namespaceComparison;
        }

        const idComparison = left.id.localeCompare(right.id);

        if (idComparison !== 0) {
          return idComparison;
        }

        return left.lineNumber - right.lineNumber;
      }).slice(0, normalizedInput.value.maxResults ?? 20),
    );
  }

  private getStore(namespace: string | undefined): ExpertAgentContextResult<ExpertAgentContextStore> {
    const namespaceResult = normalizeNamespace(namespace);

    if (!namespaceResult.ok) {
      return namespaceResult;
    }

    const store = this.stores.get(namespaceResult.value);

    if (store === undefined) {
      return error("store_unavailable", `ExpertAgent context store is not configured: ${namespaceResult.value}`, {
        namespace: namespaceResult.value,
      });
    }

    return ok(store);
  }

  private getSearchStores(
    namespace: string | undefined,
  ): ExpertAgentContextResult<readonly (readonly [string, ExpertAgentContextStore])[]> {
    if (namespace !== undefined) {
      const namespaceResult = normalizeNamespace(namespace);

      if (!namespaceResult.ok) {
        return namespaceResult;
      }

      const storeResult = this.getStore(namespaceResult.value);

      if (!storeResult.ok) {
        return storeResult;
      }

      return ok([[namespaceResult.value, storeResult.value]]);
    }

    return ok([...this.stores.entries()]);
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

export function normalizeContext(
  context: ExpertAgentContextItem,
  namespace: string | undefined = context.namespace,
): ExpertAgentContextItem {
  return {
    ...normalizeContextSummary(context, namespace),
    content: context.content,
    ...(context.contentRange === undefined
      ? {}
      : { contentRange: normalizeContentRange(context.contentRange) }),
  };
}

export function normalizeContextSummary(
  context: ExpertAgentContextItemSummary,
  namespace: string | undefined = context.namespace,
): ExpertAgentContextItemSummary {
  return {
    ...(namespace === undefined ? {} : { namespace }),
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
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    query,
    maxResults: clampInteger(input.maxResults, 1, 50, 20),
    contextLines: clampInteger(input.contextLines, 0, 5, 0),
    caseSensitive: input.caseSensitive ?? false,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}

export function normalizeSearchMatch(
  match: ExpertAgentContextItemSearchMatch,
  namespace: string | undefined = match.namespace,
): ExpertAgentContextItemSearchMatch {
  return {
    ...(namespace === undefined ? {} : { namespace }),
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
  const namespace = normalizeNamespace(input.namespace);

  if (!namespace.ok) {
    return namespace;
  }

  const start = normalizeOptionalNonNegativeInteger(input.start, "start");

  if (!start.ok) {
    return start;
  }

  const offset = normalizeOptionalPositiveInteger(input.offset, "offset");

  if (!offset.ok) {
    return offset;
  }

  return ok({
    namespace: namespace.value,
    id: input.id,
    ...(start.value === undefined ? {} : { start: start.value }),
    ...(offset.value === undefined ? {} : { offset: offset.value }),
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}

export function isSameContextItemReference(
  left: ExpertAgentContextItemReference,
  right: ExpertAgentContextItemReference,
): boolean {
  return left.namespace === right.namespace && left.id === right.id;
}

function normalizeNamespace(namespace: string | undefined): ExpertAgentContextResult<string> {
  if (typeof namespace !== "string" || namespace.trim().length === 0) {
    return error("invalid_input", "Context namespace must be a non-empty string.");
  }

  const normalized = namespace.trim();

  if (normalized.includes("/")) {
    return error("invalid_input", `Context namespace must not contain "/": ${normalized}`, {
      namespace: normalized,
    });
  }

  return ok(normalized);
}

function normalizeStoreEntries(
  stores: ContextSystemOptions["stores"],
): readonly (readonly [string, ExpertAgentContextStore])[] {
  if (stores === undefined) {
    return [];
  }

  if (stores instanceof Map) {
    return [...stores.entries()];
  }

  if (Array.isArray(stores)) {
    return stores;
  }

  return Object.entries(stores);
}

function stripNamespace<TInput extends { readonly namespace?: string | undefined }>(
  input: TInput,
): Omit<TInput, "namespace"> {
  const { namespace, ...rest } = input;
  void namespace;

  return rest;
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
