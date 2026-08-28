import type { ContextTrigger as SharedContextTrigger } from "@pragma/shared";

import type { ExpertAgentRunContext } from "../runtime/run-context.ts";

export const AGENTS_CONTEXT_ID = "AGENTS.md";
export const HOST_CONTEXT_NAMESPACE = "host";

export type ContextTrigger = SharedContextTrigger;
export type ContextPriority = "critical" | "high" | "normal" | "low";
export type ContextTrustLevel = "system" | "workspace" | "user" | "external";
export type ContextSensitivity = "public" | "internal" | "confidential" | "restricted";
export type ContextSearchScope = "path" | "content" | "hybrid";
export type ContextSearchMatchType = "path" | "content";
export type ContextPreloadReason = "always_on" | "preload_path";

export interface ExpertAgentContextItemReference {
  readonly namespace?: string | undefined;
  readonly id: string;
}

export type ExpertAgentContextErrorCode =
  | "context_not_found"
  | "context_already_exists"
  | "context_conflict"
  | "context_too_large"
  | "context_budget_exceeded"
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
  readonly priority: ContextPriority;
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
  /** Display-only Store name; it never participates in Context addressing. */
  readonly storeName?: string | undefined;
  readonly required?: boolean | undefined;
  readonly mutationApproval?: ContextMutationApproval | undefined;
  readonly overflowTarget?: boolean | undefined;
}

/**
 * `always_on_required` keeps ordinary mutations unblocked while requiring approval whenever an
 * add or full replacement explicitly requests the `always_on` trigger.
 */
export type ContextMutationApproval = "none" | "required" | "always_on_required";

export interface ExpertAgentContextStoreRegistration {
  readonly namespace: string;
  readonly storeName?: string | undefined;
  readonly required: boolean;
  readonly mutationApproval: ContextMutationApproval;
  readonly overflowTarget: boolean;
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
  readonly namespace?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export type ContextEditMode = "replace" | "search_replace" | "append" | "prepend";

export type ContextBoundarySeparator = "none" | "newline" | "blank_line";

interface ExpertAgentContextItemEditBaseInput {
  readonly namespace: string;
  readonly id: string;
  readonly expectedRevision?: string | undefined;
  readonly expectedEtag?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemReplaceEditInput extends ExpertAgentContextItemEditBaseInput {
  readonly mode: "replace";
  readonly content?: string | undefined;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
}

export interface ExpertAgentContextItemSearchReplaceEditInput extends ExpertAgentContextItemEditBaseInput {
  readonly mode?: "search_replace" | undefined;
  readonly search: string;
  readonly replace: string;
  readonly replaceAll?: boolean | undefined;
}

interface ExpertAgentContextItemBoundaryEditBaseInput extends ExpertAgentContextItemEditBaseInput {
  readonly content: string;
  readonly separator: ContextBoundarySeparator;
}

export interface ExpertAgentContextItemAppendEditInput extends ExpertAgentContextItemBoundaryEditBaseInput {
  readonly mode: "append";
}

export interface ExpertAgentContextItemPrependEditInput extends ExpertAgentContextItemBoundaryEditBaseInput {
  readonly mode: "prepend";
}

export type ExpertAgentContextItemEditInput =
  | ExpertAgentContextItemReplaceEditInput
  | ExpertAgentContextItemSearchReplaceEditInput
  | ExpertAgentContextItemAppendEditInput
  | ExpertAgentContextItemPrependEditInput;

interface ExpertAgentStoredContextItemEditBaseInput {
  readonly id: string;
  readonly expectedRevision?: string | undefined;
  readonly expectedEtag?: string | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentStoredContextItemReplaceEditInput extends ExpertAgentStoredContextItemEditBaseInput {
  readonly mode: "replace";
  readonly content?: string | undefined;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
}

export interface ExpertAgentStoredContextItemSearchReplaceEditInput extends ExpertAgentStoredContextItemEditBaseInput {
  readonly mode: "search_replace";
  readonly search: string;
  readonly replace: string;
  readonly replaceAll?: boolean | undefined;
}

interface ExpertAgentStoredContextItemBoundaryEditBaseInput extends ExpertAgentStoredContextItemEditBaseInput {
  readonly content: string;
  readonly separator: ContextBoundarySeparator;
}

export interface ExpertAgentStoredContextItemAppendEditInput extends ExpertAgentStoredContextItemBoundaryEditBaseInput {
  readonly mode: "append";
}

export interface ExpertAgentStoredContextItemPrependEditInput extends ExpertAgentStoredContextItemBoundaryEditBaseInput {
  readonly mode: "prepend";
}

export type ExpertAgentStoredContextItemEditInput =
  | ExpertAgentStoredContextItemReplaceEditInput
  | ExpertAgentStoredContextItemSearchReplaceEditInput
  | ExpertAgentStoredContextItemAppendEditInput
  | ExpertAgentStoredContextItemPrependEditInput;

export interface ExpertAgentContextItemEditResult extends ExpertAgentContextItem {
  readonly mode: ContextEditMode;
  readonly replacementCount?: number | undefined;
}

export interface ExpertAgentStoredContextItemEditResult extends ExpertAgentStoredContextItem {
  readonly mode: ContextEditMode;
  readonly replacementCount?: number | undefined;
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
  readonly effect?: "item_deleted" | "local_change_removed" | undefined;
  readonly message?: string | undefined;
}

export type ExpertAgentStoredContextItemDeleteResult = Omit<
  ExpertAgentContextItemDeleteResult,
  "namespace"
>;

export interface ExpertAgentContextItemSearchInput {
  readonly namespace?: string | undefined;
  readonly query: string;
  readonly scope?: ContextSearchScope | undefined;
  readonly maxResults?: number | undefined;
  readonly contextLines?: number | undefined;
  readonly caseSensitive?: boolean | undefined;
  readonly context?: ExpertAgentRunContext | undefined;
}

export interface ExpertAgentContextItemSearchMatch {
  readonly namespace?: string | undefined;
  readonly id: string;
  readonly matchType?: ContextSearchMatchType | undefined;
  readonly lineNumber?: number | undefined;
  readonly line: string;
  readonly before?: readonly string[] | undefined;
  readonly after?: readonly string[] | undefined;
}

export interface ExpertAgentStoredContextItemSearchInput {
  readonly query: string;
  readonly scope?: ContextSearchScope | undefined;
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

export interface ExpertAgentContextRootLoadRules {
  readonly preloadPaths?: readonly string[] | undefined;
  readonly forbiddenLoad?: readonly string[] | undefined;
  readonly priorityRules?: readonly ExpertAgentContextPriorityRule[] | undefined;
}

export interface ExpertAgentContextPriorityRule {
  readonly pattern: string;
  readonly priority: ContextPriority;
}

export interface ExpertAgentContextRoot {
  readonly namespace?: string | undefined;
  readonly path?: string | undefined;
  readonly load?: ExpertAgentContextRootLoadRules | undefined;
}

export interface NormalizedExpertAgentContextRoot {
  readonly namespace: string;
  readonly path?: string | undefined;
  readonly load: {
    readonly preloadPaths: readonly string[];
    readonly forbiddenLoad: readonly string[];
    readonly priorityRules: readonly ExpertAgentContextPriorityRule[];
  };
}

export interface ContextAssemblySelection {
  readonly context: readonly ExpertAgentContextItemSummary[];
  readonly preload: readonly ContextPreloadSelection[];
  readonly excluded: readonly ExpertAgentContextItemReference[];
}

export interface ContextPreloadSelection extends ExpertAgentContextItemReference {
  readonly reasons: readonly ContextPreloadReason[];
}

export interface ContextStoreIssue {
  readonly namespace: string;
  readonly operation: "list";
  readonly error: ExpertAgentContextError;
}

/** Display-only metadata for one namespace in a Context index. */
export interface ContextStoreIndexSummary {
  readonly namespace: string;
  readonly storeName?: string | undefined;
  readonly itemCount?: number | undefined;
}

export interface ContextIndex {
  readonly items: readonly ExpertAgentContextItemSummary[];
  readonly issues: readonly ContextStoreIssue[];
  /** Optional for source compatibility with custom Context index providers. */
  readonly stores?: readonly ContextStoreIndexSummary[] | undefined;
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
  readonly editContext: (
    input: ExpertAgentStoredContextItemEditInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>>;
  readonly deleteContext: (
    input: ExpertAgentStoredContextItemDeleteInput,
  ) => Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemDeleteResult>>;
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
  readonly roots?: readonly ExpertAgentContextRoot[] | undefined;
}

export class ContextSystem {
  private readonly stores = new Map<
    string,
    {
      readonly store: ExpertAgentContextStore;
      readonly storeName?: string | undefined;
      readonly required: boolean;
      readonly mutationApproval: ContextMutationApproval;
      readonly overflowTarget: boolean;
    }
  >();
  readonly roots: readonly NormalizedExpertAgentContextRoot[];

  constructor(options: ContextSystemOptions = {}) {
    if (options.store !== undefined) {
      this.registerOrThrow({
        namespace: HOST_CONTEXT_NAMESPACE,
        store: options.store,
        required: true,
      });
    }

    for (const [namespace, store] of normalizeStoreEntries(options.stores)) {
      this.registerOrThrow({ namespace, store, required: false });
    }

    this.roots = normalizeContextRoots(options.roots);
  }

  extend(options: ContextSystemOptions): ContextSystem {
    const extended = new ContextSystem({
      roots:
        this.roots.length === 0 ? [] : [...this.roots, ...normalizeContextRoots(options.roots)],
    });

    for (const [namespace, binding] of this.stores) {
      extended.registerOrThrow({ namespace, ...binding });
    }

    if (options.store !== undefined) {
      extended.registerOrThrow({
        namespace: HOST_CONTEXT_NAMESPACE,
        store: options.store,
        required: true,
      });
    }

    for (const [namespace, store] of normalizeStoreEntries(options.stores)) {
      extended.registerOrThrow({ namespace, store, required: false });
    }

    return extended;
  }

  register(
    input: ExpertAgentContextStoreRegistrationInput,
  ): ExpertAgentContextResult<ExpertAgentContextStoreRegistration> {
    const namespaceResult = normalizeNamespace(input.namespace);

    if (!namespaceResult.ok) {
      return namespaceResult;
    }

    if (this.stores.has(namespaceResult.value)) {
      return error(
        "context_already_exists",
        `Context store already exists: ${namespaceResult.value}`,
        {
          namespace: namespaceResult.value,
        },
      );
    }

    const required = input.required ?? false;
    const storeName = normalizeStoreName(input.storeName);
    if (!storeName.ok) return storeName;
    const mutationApproval = input.mutationApproval ?? "required";
    const overflowTarget = input.overflowTarget ?? false;

    if (overflowTarget && this.overflowTargetNamespace !== undefined) {
      return error(
        "invalid_input",
        `Only one Context store can be the overflow target; already configured: ${this.overflowTargetNamespace}`,
      );
    }

    this.stores.set(namespaceResult.value, {
      store: input.store,
      ...(storeName.value === undefined ? {} : { storeName: storeName.value }),
      required,
      mutationApproval,
      overflowTarget,
    });

    return ok({
      namespace: namespaceResult.value,
      ...(storeName.value === undefined ? {} : { storeName: storeName.value }),
      required,
      mutationApproval,
      overflowTarget,
    });
  }

  get overflowTargetNamespace(): string | undefined {
    return [...this.stores].find(([, binding]) => binding.overflowTarget)?.[0];
  }

  mutationApprovalFor(namespace: string): ContextMutationApproval {
    return this.stores.get(namespace)?.mutationApproval ?? "required";
  }

  private registerOrThrow(input: ExpertAgentContextStoreRegistrationInput): void {
    const result = this.register(input);

    if (!result.ok) {
      throw new TypeError(result.error.message);
    }
  }

  async index(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<ContextIndex>> {
    if (this.stores.size === 0) {
      return ok({ items: [], issues: [], stores: [] });
    }

    const summaries: ExpertAgentContextItemSummary[] = [];
    const issues: ContextStoreIssue[] = [];
    const storesResult = this.getStoresForNamespace(input.namespace);
    const stores: ContextStoreIndexSummary[] = [];

    if (!storesResult.ok) {
      return storesResult;
    }

    for (const [namespace, store] of storesResult.value) {
      const binding = this.stores.get(namespace)!;
      const listResult = await store.listContext({ context: input.context });

      if (!listResult.ok) {
        if (binding.required) {
          return listResult;
        }

        issues.push({ namespace, operation: "list", error: listResult.error });
        stores.push({
          namespace,
          ...(binding.storeName === undefined ? {} : { storeName: binding.storeName }),
        });
        continue;
      }

      summaries.push(...listResult.value.map((item) => normalizeContextSummary(item, namespace)));
      stores.push({
        namespace,
        ...(binding.storeName === undefined ? {} : { storeName: binding.storeName }),
        itemCount: listResult.value.length,
      });
    }

    return ok({ items: sortContextSummaries(summaries), issues, stores });
  }

  selectContext(summaries: readonly ExpertAgentContextItemSummary[]): ContextAssemblySelection {
    if (this.roots.length === 0) {
      return {
        context: sortContextSummaries(
          summaries.filter((summary) => summary.metadata.trigger === "model_decision"),
        ),
        preload: createAlwaysOnPreloadSelections(summaries),
        excluded: [],
      };
    }

    const excluded = new Map<string, ExpertAgentContextItemReference>();
    const preload = new Map<string, ContextPreloadReason[]>();
    const allowed = new Map<string, ExpertAgentContextItemSummary>();

    for (const summary of summaries) {
      const key = createContextReferenceKey(summary);

      for (const root of this.roots) {
        if (!matchesContextRoot(summary, root)) {
          continue;
        }

        if (matchesAnyPattern(summary.id, root.load.forbiddenLoad)) {
          excluded.set(key, toContextReference(summary));
          allowed.delete(key);
          preload.delete(key);
          break;
        }

        const prioritized = applyPriorityRules(
          allowed.get(key) ?? summary,
          root.load.priorityRules,
        );
        allowed.set(key, prioritized);

        if (matchesAnyPattern(summary.id, root.load.preloadPaths)) {
          addPreloadReason(preload, key, "preload_path");
        }

        if (prioritized.metadata.trigger === "always_on") {
          addPreloadReason(preload, key, "always_on");
        }
      }
    }

    return {
      context: sortContextSummaries(
        [...allowed.values()].filter((summary) => summary.metadata.trigger === "model_decision"),
      ),
      preload: sortContextSummaries([...allowed.values()])
        .map((summary) => {
          const key = createContextReferenceKey(summary);
          return excluded.has(key)
            ? undefined
            : toPreloadSelection(allowed, key, preload.get(key) ?? []);
        })
        .filter((item) => item?.reasons.length !== 0)
        .filter((item): item is ContextPreloadSelection => item !== undefined),
      excluded: [...excluded.values()],
    };
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

  async edit(
    input: ExpertAgentContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItemEditResult>> {
    const normalizedInput = normalizeEditInput(input);

    if (!normalizedInput.ok) {
      return normalizedInput;
    }

    const storeResult = this.getStore(normalizedInput.value.namespace);

    if (!storeResult.ok) {
      return storeResult;
    }

    const storeInput = await this.prepareStoredEditInput(storeResult.value, normalizedInput.value);

    if (!storeInput.ok) {
      return storeInput;
    }

    const result = await storeResult.value.editContext(toStoredEditInput(storeInput.value));

    if (!result.ok) {
      return result;
    }

    return ok({
      ...normalizeContext(result.value, normalizedInput.value.namespace),
      mode: result.value.mode,
      ...(result.value.replacementCount === undefined
        ? {}
        : { replacementCount: result.value.replacementCount }),
    });
  }

  private async prepareStoredEditInput(
    store: ExpertAgentContextStore,
    input: ExpertAgentContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentContextItemEditInput>> {
    if (input.mode !== "replace") {
      return ok(input);
    }

    const existing = await store.readContext({
      id: input.id,
      context: input.context,
    });

    if (!existing.ok) {
      return existing;
    }

    return ok({
      ...input,
      metadata: normalizeUpdateMetadata(input.id, existing.value.metadata, input.metadata),
    });
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

    return ok({ namespace: namespaceResult.value, ...result.value });
  }

  async search(
    input: ExpertAgentContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const normalizedInput = normalizeSearchInput(input);

    if (!normalizedInput.ok) {
      return normalizedInput;
    }

    const matches: ExpertAgentContextItemSearchMatch[] = [];
    const storesResult = this.getStoresForNamespace(normalizedInput.value.namespace);

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
      matches
        .sort((left, right) => {
          const namespaceComparison = (left.namespace ?? "").localeCompare(right.namespace ?? "");

          if (namespaceComparison !== 0) {
            return namespaceComparison;
          }

          const idComparison = left.id.localeCompare(right.id);

          if (idComparison !== 0) {
            return idComparison;
          }

          const leftLine = left.lineNumber ?? 0;
          const rightLine = right.lineNumber ?? 0;

          if (leftLine !== rightLine) {
            return leftLine - rightLine;
          }

          return (left.matchType ?? "content").localeCompare(right.matchType ?? "content");
        })
        .slice(0, normalizedInput.value.maxResults ?? 20),
    );
  }

  private getStore(
    namespace: string | undefined,
  ): ExpertAgentContextResult<ExpertAgentContextStore> {
    const namespaceResult = normalizeNamespace(namespace);

    if (!namespaceResult.ok) {
      return namespaceResult;
    }

    const binding = this.stores.get(namespaceResult.value);

    if (binding === undefined) {
      return error(
        "store_unavailable",
        `Expert context store is not configured: ${namespaceResult.value}`,
        {
          namespace: namespaceResult.value,
        },
      );
    }

    return ok(binding.store);
  }

  private getStoresForNamespace(
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

    return ok([...this.stores.entries()].map(([namespace, binding]) => [namespace, binding.store]));
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
  metadata: Partial<ExpertAgentContextItemMetadata>,
): ExpertAgentContextItemMetadata {
  void id;
  return {
    ...(metadata.description === undefined ? {} : { description: metadata.description }),
    trigger: normalizeTrigger(metadata.trigger),
    ...(metadata.trustLevel === undefined
      ? {}
      : { trustLevel: normalizeTrustLevel(metadata.trustLevel) }),
    ...(metadata.sensitivity === undefined
      ? {}
      : { sensitivity: normalizeSensitivity(metadata.sensitivity) }),
    priority: normalizePriority(metadata.priority),
  };
}

function normalizeCreateMetadata(
  metadata: Partial<ExpertAgentContextItemMetadata> | undefined,
): ExpertAgentContextItemMetadata {
  if (metadata === undefined) {
    return {
      trigger: "manual",
      priority: "normal",
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
    priority: normalizePriority(metadata.priority),
  };
}

function normalizeUpdateMetadata(
  id: string,
  existingMetadata: ExpertAgentContextItemMetadata,
  metadata: Partial<ExpertAgentContextItemMetadata> | undefined,
): ExpertAgentContextItemMetadata {
  void id;
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
    priority: normalizePriority(metadata?.priority ?? existingMetadata.priority),
  };
}

export function normalizeTrigger(trigger: ContextTrigger | undefined): ContextTrigger {
  if (trigger === "always_on" || trigger === "model_decision" || trigger === "manual") {
    return trigger;
  }

  return "manual";
}

export function normalizeSearchInput(
  input: ExpertAgentContextItemSearchInput,
): ExpertAgentContextResult<ExpertAgentContextItemSearchInput> {
  const query = input.query.trim();

  if (query.length === 0) {
    return error("invalid_input", "Context search query must not be empty.");
  }

  const scope = normalizeSearchScope(input.scope);

  if (!scope.ok) {
    return scope;
  }

  return ok({
    ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
    query,
    scope: scope.value,
    maxResults: clampInteger(input.maxResults, 1, 50, 20),
    contextLines: clampInteger(input.contextLines, 0, 5, 0),
    caseSensitive: input.caseSensitive ?? false,
    ...(input.context === undefined ? {} : { context: input.context }),
  });
}

export function normalizeEditInput(
  input: ExpertAgentContextItemEditInput,
): ExpertAgentContextResult<ExpertAgentContextItemEditInput> {
  const namespace = normalizeNamespace(input.namespace);

  if (!namespace.ok) {
    return namespace;
  }

  if (input.mode === "replace") {
    return ok({
      namespace: namespace.value,
      id: input.id,
      mode: "replace",
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.expectedEtag === undefined ? {} : { expectedEtag: input.expectedEtag }),
      ...(input.context === undefined ? {} : { context: input.context }),
    });
  }

  if (input.mode === "append" || input.mode === "prepend") {
    return ok({
      namespace: namespace.value,
      id: input.id,
      mode: input.mode,
      content: input.content,
      separator: input.separator,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.expectedEtag === undefined ? {} : { expectedEtag: input.expectedEtag }),
      ...(input.context === undefined ? {} : { context: input.context }),
    });
  }

  if (input.search.trim().length === 0) {
    return error("invalid_input", 'Context edit parameter "search" must not be empty.');
  }

  return ok({
    namespace: namespace.value,
    id: input.id,
    mode: "search_replace",
    search: input.search,
    replace: input.replace,
    replaceAll: input.replaceAll ?? false,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    ...(input.expectedEtag === undefined ? {} : { expectedEtag: input.expectedEtag }),
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
    matchType: normalizeSearchMatchType(match.matchType ?? "content"),
    ...(match.lineNumber === undefined
      ? {}
      : { lineNumber: Math.max(1, Math.trunc(match.lineNumber)) }),
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

export function matchesAnyPattern(id: string, patterns: readonly string[]): boolean {
  return patterns.some((pattern) => matchContextPattern(id, pattern));
}

export function matchContextPattern(id: string, pattern: string, caseSensitive = true): boolean {
  const normalizedPattern = pattern.trim();

  if (normalizedPattern.length === 0) {
    return false;
  }

  let source = "^";

  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index];

    if (character === undefined) {
      continue;
    }

    if (character === "*") {
      const next = normalizedPattern[index + 1];

      if (next === "*") {
        source += ".*";
        index += 1;
      } else {
        source += "[^/]*";
      }

      continue;
    }

    if (character === "?") {
      source += "[^/]";
      continue;
    }

    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }

  source += "$";
  const regex = new RegExp(source, caseSensitive ? undefined : "i");

  return regex.test(id);
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

function normalizeStoreName(
  storeName: string | undefined,
): ExpertAgentContextResult<string | undefined> {
  if (storeName === undefined) return ok(undefined);
  if (storeName.trim().length === 0) {
    return error("invalid_input", "Context store name must be a non-empty string.");
  }
  return ok(storeName.trim());
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

function normalizeContextRoots(
  roots: readonly ExpertAgentContextRoot[] | undefined,
): readonly NormalizedExpertAgentContextRoot[] {
  if (roots === undefined) {
    return [];
  }

  return roots.map((root) => {
    const namespaceResult = normalizeNamespace(root.namespace ?? HOST_CONTEXT_NAMESPACE);
    const path = root.path === undefined ? undefined : trimPattern(root.path);

    if (!namespaceResult.ok) {
      throw new TypeError(namespaceResult.error.message);
    }

    return {
      namespace: namespaceResult.value,
      ...(path === undefined || path.length === 0 ? {} : { path }),
      load: {
        preloadPaths: normalizePatterns(root.load?.preloadPaths),
        forbiddenLoad: normalizePatterns(root.load?.forbiddenLoad),
        priorityRules: normalizePriorityRules(root.load?.priorityRules),
      },
    };
  });
}

function createAlwaysOnPreloadSelections(
  summaries: readonly ExpertAgentContextItemSummary[],
): readonly ContextPreloadSelection[] {
  return summaries
    .filter((summary) => summary.metadata.trigger === "always_on")
    .map((summary) => ({
      ...toContextReference(summary),
      reasons: ["always_on"],
    }));
}

function addPreloadReason(
  preload: Map<string, ContextPreloadReason[]>,
  key: string,
  reason: ContextPreloadReason,
): void {
  const existing = preload.get(key);

  if (existing === undefined) {
    preload.set(key, [reason]);
    return;
  }

  if (!existing.includes(reason)) {
    existing.push(reason);
  }
}

function toPreloadSelection(
  allowed: ReadonlyMap<string, ExpertAgentContextItemSummary>,
  key: string | undefined,
  reasons: readonly ContextPreloadReason[],
): ContextPreloadSelection | undefined {
  if (key === undefined) {
    return undefined;
  }

  const summary = allowed.get(key);

  if (summary === undefined) {
    return undefined;
  }

  return {
    ...toContextReference(summary),
    reasons: [...reasons],
  };
}

function normalizePatterns(patterns: readonly string[] | undefined): readonly string[] {
  return (patterns ?? []).map(trimPattern).filter((pattern) => pattern.length > 0);
}

function trimPattern(pattern: string): string {
  return pattern.trim();
}

function stripNamespace<TInput extends { readonly namespace?: string | undefined }>(
  input: TInput,
): Omit<TInput, "namespace"> {
  const { namespace, ...rest } = input;
  void namespace;

  return rest;
}

function toStoredEditInput(
  input: ExpertAgentContextItemEditInput,
): ExpertAgentStoredContextItemEditInput {
  if (input.mode === "replace") {
    return {
      id: input.id,
      mode: "replace",
      ...(input.content === undefined ? {} : { content: input.content }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.expectedEtag === undefined ? {} : { expectedEtag: input.expectedEtag }),
      ...(input.context === undefined ? {} : { context: input.context }),
    };
  }

  if (input.mode === "append" || input.mode === "prepend") {
    return {
      id: input.id,
      mode: input.mode,
      content: input.content,
      separator: input.separator,
      ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
      ...(input.expectedEtag === undefined ? {} : { expectedEtag: input.expectedEtag }),
      ...(input.context === undefined ? {} : { context: input.context }),
    };
  }

  return {
    id: input.id,
    mode: "search_replace",
    search: input.search,
    replace: input.replace,
    replaceAll: input.replaceAll,
    ...(input.expectedRevision === undefined ? {} : { expectedRevision: input.expectedRevision }),
    ...(input.expectedEtag === undefined ? {} : { expectedEtag: input.expectedEtag }),
    ...(input.context === undefined ? {} : { context: input.context }),
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

export function normalizePriority(value: string | undefined): ContextPriority {
  if (value === "critical" || value === "high" || value === "normal" || value === "low") {
    return value;
  }

  return "normal";
}

function normalizeSearchScope(
  scope: ContextSearchScope | undefined,
): ExpertAgentContextResult<ContextSearchScope> {
  if (scope === undefined || scope === "hybrid" || scope === "content" || scope === "path") {
    return ok(scope ?? "hybrid");
  }

  return error("invalid_input", "Context search scope must be path, content, or hybrid.");
}

function normalizeSearchMatchType(
  matchType: ContextSearchMatchType | undefined,
): ContextSearchMatchType {
  return matchType === "path" ? "path" : "content";
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

function createContextReferenceKey(reference: ExpertAgentContextItemReference): string {
  return `${reference.namespace ?? ""}::${reference.id}`;
}

function toContextReference(
  context: ExpertAgentContextItemReference,
): ExpertAgentContextItemReference {
  return {
    ...(context.namespace === undefined ? {} : { namespace: context.namespace }),
    id: context.id,
  };
}

function sortContextSummaries(
  summaries: readonly ExpertAgentContextItemSummary[],
): readonly ExpertAgentContextItemSummary[] {
  return [...summaries].sort((left, right) => {
    const priorityComparison = compareContextPriority(
      left.metadata.priority,
      right.metadata.priority,
    );

    if (priorityComparison !== 0) {
      return priorityComparison;
    }

    const namespaceComparison = (left.namespace ?? "").localeCompare(right.namespace ?? "");

    if (namespaceComparison !== 0) {
      return namespaceComparison;
    }

    return left.id.localeCompare(right.id);
  });
}

function compareContextPriority(left: ContextPriority, right: ContextPriority): number {
  const rank: Record<ContextPriority, number> = {
    critical: 0,
    high: 1,
    normal: 2,
    low: 3,
  };

  return rank[left] - rank[right];
}

function normalizePriorityRules(
  rules: readonly ExpertAgentContextPriorityRule[] | undefined,
): readonly ExpertAgentContextPriorityRule[] {
  return (rules ?? [])
    .map((rule) => ({ pattern: rule.pattern.trim(), priority: normalizePriority(rule.priority) }))
    .filter((rule) => rule.pattern.length > 0);
}

function applyPriorityRules(
  summary: ExpertAgentContextItemSummary,
  rules: readonly ExpertAgentContextPriorityRule[],
): ExpertAgentContextItemSummary {
  const priority = rules
    .filter((rule) => matchContextPattern(summary.id, rule.pattern))
    .map((rule) => rule.priority)
    .reduce(
      (selected, candidate) =>
        compareContextPriority(candidate, selected) < 0 ? candidate : selected,
      summary.metadata.priority,
    );

  if (priority === summary.metadata.priority) {
    return summary;
  }

  return {
    ...summary,
    metadata: {
      ...summary.metadata,
      priority,
    },
  };
}

function matchesContextRoot(
  summary: ExpertAgentContextItemSummary,
  root: NormalizedExpertAgentContextRoot,
): boolean {
  if ((summary.namespace ?? HOST_CONTEXT_NAMESPACE) !== root.namespace) {
    return false;
  }

  if (root.path === undefined) {
    return true;
  }

  return summary.id === root.path || summary.id.startsWith(`${root.path.replace(/\/+$/, "")}/`);
}
