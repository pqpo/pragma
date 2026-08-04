import { createHash, randomUUID } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { HandoffContextReferenceSchema, type HandoffContextReference } from "@pragma/shared";
import { z } from "zod";

import {
  error,
  ok,
  type ExpertAgentContextItemListInput,
  type ExpertAgentContextItemMetadata,
  type ExpertAgentContextItemSearchMatch,
  type ExpertAgentContextItemSummary,
  type ExpertAgentContextResult,
  type ExpertAgentContextStore,
  type ExpertAgentStoredContextItem,
  type ExpertAgentStoredContextItemDeleteInput,
  type ExpertAgentStoredContextItemEditInput,
  type ExpertAgentStoredContextItemEditResult,
  type ExpertAgentStoredContextItemReadInput,
  type ExpertAgentStoredContextItemReadResult,
  type ExpertAgentStoredContextItemSearchInput,
  type ExpertAgentStoredContextRegisterInput,
} from "../../context-system/context-system.ts";
import { readExecutionRunScope } from "../../runtime/run-context.ts";
import { withFileLock } from "../../storage/file-lock.ts";
import { PragmaPaths } from "../../storage/pragma-paths.ts";

const HANDOFF_NAMESPACE = "pragma.handoff" as const;
const MANIFEST_SCHEMA_VERSION = "pragma.execution-handoffs/v2" as const;
const FILE_VALIDATION_CHUNK_BYTES = 64 * 1024;
const SEARCH_CHUNK_BYTES = 64 * 1024;
const SEARCH_SNIPPET_CHARACTERS = 1_024;

const ManagedSourceSchema = z.object({
  type: z.literal("managed"),
  relativePath: z.string().min(1),
  sha256: z.string().length(64),
});

const WorkspaceSourceSchema = z.object({
  type: z.literal("workspace"),
  workspaceRoot: z.string().min(1),
  relativePath: z.string().min(1),
});

const HandoffEntrySchema = z.object({
  id: z.string().min(1),
  invocationId: z.string().min(1),
  attemptId: z.string().min(1),
  source: z.discriminatedUnion("type", [ManagedSourceSchema, WorkspaceSourceSchema]),
  mediaType: z.string().min(1),
  description: z.string().optional(),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().datetime(),
});

const HandoffManifestSchema = z.object({
  schemaVersion: z.literal(MANIFEST_SCHEMA_VERSION),
  entries: z.array(HandoffEntrySchema),
});

type HandoffEntry = z.infer<typeof HandoffEntrySchema>;
type HandoffManifest = z.infer<typeof HandoffManifestSchema>;

interface HandoffEntryMetadata {
  readonly id: string;
  readonly metadata: ExpertAgentContextItemMetadata;
  readonly revision: string;
  readonly etag: string;
  readonly sizeBytes: number;
}

export interface RegisterManagedHandoffInput {
  readonly id: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly description?: string | undefined;
  readonly idempotencyKey: string;
}

export interface RegisterWorkspaceHandoffInput {
  readonly id: string;
  readonly invocationId: string;
  readonly attemptId: string;
  readonly workspaceRoot: string;
  readonly relativePath: string;
  readonly mediaType: string;
  readonly description?: string | undefined;
  readonly idempotencyKey: string;
}

export interface FederatedExecutionHandoffContextStoreOptions {
  readonly defaultExecutionId: string;
  readonly defaultStore?: ExecutionHandoffContextStore | undefined;
  readonly resolveVisibleExecutionIds: (
    activeExecutionId: string,
  ) => Promise<readonly string[]> | readonly string[];
  readonly pragmaHome?: string | undefined;
}

export class FederatedExecutionHandoffContextStore implements ExpertAgentContextStore {
  readonly namespace = HANDOFF_NAMESPACE;
  private readonly paths: PragmaPaths;
  private readonly stores = new Map<string, ExecutionHandoffContextStore>();

  constructor(private readonly options: FederatedExecutionHandoffContextStoreOptions) {
    this.paths = new PragmaPaths(options);
    if (options.defaultStore !== undefined) {
      if (options.defaultStore.executionId !== options.defaultExecutionId) {
        throw new Error("Federated handoff default Store must match the default Execution id.");
      }
      this.stores.set(options.defaultExecutionId, options.defaultStore);
    }
  }

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    try {
      const stores = await this.resolveStores(input.context);
      const conflict = findDuplicateEntryId(
        await Promise.all(
          stores.map(async (store) => ({
            executionId: store.executionId,
            ids: await store.listContextIds(),
          })),
        ),
      );
      if (conflict !== undefined) return duplicateContextError(conflict.id, conflict.executionIds);

      const results = await Promise.all(
        stores.map(async (store) => await store.listContext(input)),
      );
      const summaries: ExpertAgentContextItemSummary[] = [];
      for (const result of results) {
        if (!result.ok) return result;
        summaries.push(...result.value);
      }
      return ok(summaries);
    } catch (caught) {
      return error("store_error", "Failed to list visible handoffs.", toErrorDetails(caught));
    }
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    try {
      const stores = await this.resolveStores(input.context);
      const matches: ExecutionHandoffContextStore[] = [];
      for (const store of stores) {
        if (await store.hasContext(input.id)) matches.push(store);
      }
      if (matches.length === 0) {
        return error("context_not_found", `Handoff context not found: ${input.id}`, {
          id: input.id,
        });
      }
      if (matches.length > 1) {
        return duplicateContextError(
          input.id,
          matches.map((store) => store.executionId),
        );
      }
      return await matches[0]!.readContext(input);
    } catch (caught) {
      return error(
        "store_error",
        `Failed to read visible handoff context: ${input.id}`,
        toErrorDetails(caught),
      );
    }
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const query = input.query.trim();
    if (query === "") return error("invalid_input", "Context search query must not be empty.");
    try {
      const stores = await this.resolveStores(input.context);
      const duplicate = findDuplicateEntryId(
        await Promise.all(
          stores.map(async (store) => ({
            executionId: store.executionId,
            ids: await store.listContextIds(),
          })),
        ),
      );
      if (duplicate !== undefined) {
        return duplicateContextError(duplicate.id, duplicate.executionIds);
      }

      const maxResults = Math.max(1, Math.trunc(input.maxResults ?? 20));
      const matches: ExpertAgentContextItemSearchMatch[] = [];
      for (const store of stores.toReversed()) {
        const result = await store.searchContext({
          ...input,
          maxResults: maxResults - matches.length,
        });
        if (!result.ok) return result;
        matches.push(...result.value);
        if (matches.length >= maxResults) break;
      }
      return ok(matches);
    } catch (caught) {
      return error("store_error", "Failed to search visible handoffs.", toErrorDetails(caught));
    }
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    void input;
    return error("permission_denied", "Execution handoffs are read-only.");
  }

  async editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    void input;
    return error("permission_denied", "Execution handoffs are read-only.");
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    void input;
    return error("permission_denied", "Execution handoffs are read-only.");
  }

  private async resolveStores(
    context: ExpertAgentContextItemListInput["context"],
  ): Promise<readonly ExecutionHandoffContextStore[]> {
    const activeExecutionId =
      readExecutionRunScope(context).executionId ?? this.options.defaultExecutionId;
    const configured = await this.options.resolveVisibleExecutionIds(activeExecutionId);
    const executionIds = [...new Set([...configured, activeExecutionId])];
    return executionIds.map((executionId) => this.getStore(executionId));
  }

  private getStore(executionId: string): ExecutionHandoffContextStore {
    let store = this.stores.get(executionId);
    if (store === undefined) {
      store = new ExecutionHandoffContextStore(executionId, { pragmaHome: this.paths.root });
      this.stores.set(executionId, store);
    }
    return store;
  }
}

export class ExecutionHandoffContextStore implements ExpertAgentContextStore {
  readonly namespace = HANDOFF_NAMESPACE;
  private readonly paths: PragmaPaths;

  constructor(
    readonly executionId: string,
    options: { readonly pragmaHome?: string | undefined } = {},
  ) {
    this.paths = new PragmaPaths(options);
  }

  async beginInvocationAttempt(invocationId: string, attemptId: string): Promise<void> {
    const manifestPath = this.paths.executionHandoffsManifest(this.executionId);
    await withFileLock(`${manifestPath}.lock`, async () => {
      const manifest = await this.readManifest();
      const stale = manifest.entries.filter(
        (entry) => entry.invocationId === invocationId && entry.attemptId !== attemptId,
      );
      if (stale.length === 0) return;

      for (const entry of stale) {
        if (entry.source.type !== "managed") continue;
        const path = this.resolveManagedPath(entry.source.relativePath);
        await rm(path, { force: true });
      }

      await writeJsonAtomic(manifestPath, {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        entries: manifest.entries.filter(
          (entry) => entry.invocationId !== invocationId || entry.attemptId === attemptId,
        ),
      } satisfies HandoffManifest);
    });
  }

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    void input;
    try {
      const manifest = await this.readManifest();
      const summaries = await Promise.all(
        manifest.entries.map(async (entry) => {
          const metadata = await this.readEntryMetadata(entry);
          return metadata.ok ? toSummary(metadata.value) : undefined;
        }),
      );
      return ok(
        summaries.filter((item): item is ExpertAgentContextItemSummary => item !== undefined),
      );
    } catch (caught) {
      return error("store_error", "Failed to list Execution handoffs.", toErrorDetails(caught));
    }
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    let handle: FileHandle | undefined;
    try {
      const entry = (await this.readManifest()).entries.find(
        (candidate) => candidate.id === input.id,
      );
      if (entry === undefined) {
        return error("context_not_found", `Handoff context not found: ${input.id}`, {
          id: input.id,
        });
      }

      const path = await this.resolveEntryPath(entry);
      const opened = await openRegularFile(path);
      handle = opened.handle;
      const sizeBytes = toSafeFileSize(opened.stats.size);
      const requestedStartOffset = Math.min(sizeBytes, Math.max(0, Math.trunc(input.start ?? 0)));
      const requestedLength =
        input.offset === undefined
          ? sizeBytes - requestedStartOffset
          : Math.min(sizeBytes - requestedStartOffset, Math.max(0, Math.trunc(input.offset)));
      const buffer = Buffer.alloc(requestedLength);
      const { bytesRead } = await handle.read(buffer, 0, requestedLength, requestedStartOffset);
      const decoded = decodeUtf8Chunk(buffer.subarray(0, bytesRead));
      const startOffset = requestedStartOffset + decoded.startIndex;
      const endOffset = requestedStartOffset + decoded.endIndex;
      const metadata = createEntryMetadata(entry, opened.stats);

      return ok({
        ...metadata,
        content: decoded.content,
        contentRange: {
          requestedStartOffset,
          startOffset,
          endOffset,
          nextStartOffset: endOffset,
          truncated: endOffset < sizeBytes,
          sizeBytes,
          ...(input.offset === undefined
            ? {}
            : { maxBytes: Math.max(1, Math.trunc(input.offset)) }),
        },
      });
    } catch (caught) {
      if (isNotFound(caught)) {
        return error("context_not_found", `Handoff context not found: ${input.id}`, {
          id: input.id,
        });
      }
      return error(
        "store_error",
        `Failed to read handoff context: ${input.id}`,
        toErrorDetails(caught),
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const query = input.query.trim();
    if (query === "") return error("invalid_input", "Context search query must not be empty.");

    try {
      const manifest = await this.readManifest();
      const matches: ExpertAgentContextItemSearchMatch[] = [];
      const maxResults = Math.max(1, Math.trunc(input.maxResults ?? 20));
      for (const entry of manifest.entries) {
        if (
          input.scope !== "content" &&
          normalizeSearchText(entry.id, input.caseSensitive).includes(
            normalizeSearchText(query, input.caseSensitive),
          )
        ) {
          matches.push({ id: entry.id, matchType: "path", line: entry.id });
        }
        if (matches.length >= maxResults) break;
        if (input.scope === "path") continue;
        await this.searchEntry(entry, input, matches, maxResults);
        if (matches.length >= maxResults) break;
      }
      return ok(matches);
    } catch (caught) {
      return error("store_error", "Failed to search Execution handoffs.", toErrorDetails(caught));
    }
  }

  async registerManaged(input: RegisterManagedHandoffInput): Promise<HandoffContextReference> {
    const relativePath = `generated/${input.id}`;
    const target = this.resolveManagedPath(relativePath);
    const entry: HandoffEntry = {
      id: input.id,
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      source: {
        type: "managed",
        relativePath,
        sha256: createHash("sha256").update(input.bytes).digest("hex"),
      },
      mediaType: input.mediaType,
      ...(input.description === undefined ? {} : { description: input.description }),
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    return await this.registerEntry(entry, async () => await writeBytesAtomic(target, input.bytes));
  }

  async registerWorkspace(input: RegisterWorkspaceHandoffInput): Promise<HandoffContextReference> {
    if (isAbsolute(input.relativePath)) {
      throw new Error("Handoff workspace path must be relative.");
    }
    const workspaceRoot = await realpath(resolve(input.workspaceRoot));
    const candidate = resolve(workspaceRoot, input.relativePath);
    assertContainedPath(workspaceRoot, candidate);
    const resolvedFile = await realpath(candidate);
    assertContainedPath(workspaceRoot, resolvedFile);
    await validateUtf8File(resolvedFile);
    return await this.registerEntry({
      id: input.id,
      invocationId: input.invocationId,
      attemptId: input.attemptId,
      source: {
        type: "workspace",
        workspaceRoot,
        relativePath: relative(workspaceRoot, resolvedFile),
      },
      mediaType: input.mediaType,
      ...(input.description === undefined ? {} : { description: input.description }),
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
    });
  }

  async listReferencesForInvocation(
    invocationId: string,
    attemptId: string,
  ): Promise<readonly HandoffContextReference[]> {
    const entries = (await this.readManifest()).entries.filter(
      (entry) => entry.invocationId === invocationId && entry.attemptId === attemptId,
    );
    const references = await Promise.all(
      entries.map(async (entry) => {
        const metadata = await this.readEntryMetadata(entry);
        return metadata.ok ? toReference(entry, metadata.value) : undefined;
      }),
    );
    return references.filter(
      (reference): reference is HandoffContextReference => reference !== undefined,
    );
  }

  async hasContext(id: string): Promise<boolean> {
    return (await this.readManifest()).entries.some((entry) => entry.id === id);
  }

  async listContextIds(): Promise<readonly string[]> {
    return (await this.readManifest()).entries.map((entry) => entry.id);
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    void input;
    return error("permission_denied", "Execution handoffs are read-only.");
  }

  async editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    void input;
    return error("permission_denied", "Execution handoffs are read-only.");
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    void input;
    return error("permission_denied", "Execution handoffs are read-only.");
  }

  private async registerEntry(
    entry: HandoffEntry,
    writeSource?: (() => Promise<void>) | undefined,
  ): Promise<HandoffContextReference> {
    const manifestPath = this.paths.executionHandoffsManifest(this.executionId);
    let registered: HandoffEntry | undefined;
    await withFileLock(`${manifestPath}.lock`, async () => {
      const manifest = await this.readManifest();
      const duplicate = manifest.entries.find(
        (candidate) => candidate.idempotencyKey === entry.idempotencyKey,
      );
      if (duplicate !== undefined) {
        if (!isSameRegistration(duplicate, entry)) {
          throw new Error(`Handoff idempotency conflict: ${entry.idempotencyKey}`);
        }
        registered = duplicate;
        return;
      }
      if (manifest.entries.some((candidate) => candidate.id === entry.id)) {
        throw new Error(`Handoff context id already exists: ${entry.id}`);
      }

      await writeSource?.();
      await writeJsonAtomic(manifestPath, {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        entries: [...manifest.entries, entry],
      } satisfies HandoffManifest);
      registered = entry;
    });

    if (registered === undefined) throw new Error("Handoff registration did not complete.");
    const metadata = await this.readEntryMetadata(registered);
    if (!metadata.ok) throw new Error(metadata.error.message);
    return toReference(registered, metadata.value);
  }

  private async readEntryMetadata(
    entry: HandoffEntry,
  ): Promise<ExpertAgentContextResult<HandoffEntryMetadata>> {
    let handle: FileHandle | undefined;
    try {
      const path = await this.resolveEntryPath(entry);
      const opened = await openRegularFile(path);
      handle = opened.handle;
      return ok(createEntryMetadata(entry, opened.stats));
    } catch (caught) {
      if (isNotFound(caught)) {
        return error("context_not_found", `Handoff context not found: ${entry.id}`, {
          id: entry.id,
        });
      }
      return error(
        "store_error",
        `Failed to inspect handoff context: ${entry.id}`,
        toErrorDetails(caught),
      );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async searchEntry(
    entry: HandoffEntry,
    input: ExpertAgentStoredContextItemSearchInput,
    matches: ExpertAgentContextItemSearchMatch[],
    maxResults: number,
  ): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      const path = await this.resolveEntryPath(entry);
      const opened = await openRegularFile(path);
      handle = opened.handle;
      const decoder = new TextDecoder("utf-8", { fatal: true });
      const buffer = Buffer.alloc(SEARCH_CHUNK_BYTES);
      const needle = normalizeSearchText(input.query.trim(), input.caseSensitive);
      let position = 0;
      let lineNumber = 1;
      let lineTail = "";
      let matchedLine = false;

      const consume = (text: string): void => {
        const segments = text.split("\n");
        for (const [index, segment] of segments.entries()) {
          const completeLine = index < segments.length - 1;
          const combined = `${lineTail}${segment}`;
          if (!matchedLine) {
            const matchAt = normalizeSearchText(combined, input.caseSensitive).indexOf(needle);
            if (matchAt >= 0) {
              matches.push({
                id: entry.id,
                matchType: "content",
                lineNumber,
                line: createSearchSnippet(
                  combined.replace(/\r$/u, ""),
                  matchAt,
                  queryLength(needle),
                ),
              });
              matchedLine = true;
            }
          }
          if (completeLine) {
            lineNumber += 1;
            lineTail = "";
            matchedLine = false;
          } else {
            const overlap = Math.max(needle.length - 1, 0);
            lineTail = combined.slice(-Math.max(overlap, 1));
          }
          if (matches.length >= maxResults) return;
        }
      };

      while (position < toSafeFileSize(opened.stats.size) && matches.length < maxResults) {
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
        if (bytesRead === 0) break;
        position += bytesRead;
        consume(decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
      }
      if (matches.length < maxResults) consume(decoder.decode());
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async resolveEntryPath(entry: HandoffEntry): Promise<string> {
    if (entry.source.type === "managed") {
      return this.resolveManagedPath(entry.source.relativePath);
    }
    const storedRoot = resolve(entry.source.workspaceRoot);
    const currentRoot = await realpath(storedRoot);
    if (currentRoot !== storedRoot) {
      throw new Error("Handoff workspace root identity changed after registration.");
    }
    const candidate = resolve(storedRoot, entry.source.relativePath);
    assertContainedPath(storedRoot, candidate);
    const path = await realpath(candidate);
    assertContainedPath(storedRoot, path);
    return path;
  }

  private resolveManagedPath(relativePath: string): string {
    const root = resolve(this.paths.executionHandoffsRoot(this.executionId));
    const path = resolve(root, relativePath);
    assertContainedPath(root, path);
    return path;
  }

  private async readManifest(): Promise<HandoffManifest> {
    try {
      return HandoffManifestSchema.parse(
        JSON.parse(await readFile(this.paths.executionHandoffsManifest(this.executionId), "utf8")),
      );
    } catch (caught) {
      if (isNotFound(caught)) {
        return { schemaVersion: MANIFEST_SCHEMA_VERSION, entries: [] };
      }
      throw caught;
    }
  }
}

function findDuplicateEntryId(
  entries: readonly { readonly executionId: string; readonly ids: readonly string[] }[],
): { readonly id: string; readonly executionIds: readonly string[] } | undefined {
  const owners = new Map<string, string>();
  for (const entry of entries) {
    for (const id of entry.ids) {
      const owner = owners.get(id);
      if (owner !== undefined) return { id, executionIds: [owner, entry.executionId] };
      owners.set(id, entry.executionId);
    }
  }
  return undefined;
}

function duplicateContextError<TValue>(
  id: string,
  executionIds: readonly string[],
): ExpertAgentContextResult<TValue> {
  return error("context_conflict", `Handoff context id is ambiguous: ${id}`, {
    id,
    executionIds,
  });
}

function createEntryMetadata(entry: HandoffEntry, stats: BigIntStats): HandoffEntryMetadata {
  const sizeBytes = toSafeFileSize(stats.size);
  const revision = `${stats.mtimeNs}:${stats.size}`;
  return {
    id: entry.id,
    metadata: {
      ...(entry.description === undefined ? {} : { description: entry.description }),
      trigger: "model_decision",
      priority: "normal",
      trustLevel: "workspace",
      sensitivity: "internal",
    },
    revision,
    etag: revision,
    sizeBytes,
  };
}

function toSummary(item: HandoffEntryMetadata): ExpertAgentContextItemSummary {
  return item;
}

function toReference(entry: HandoffEntry, item: HandoffEntryMetadata): HandoffContextReference {
  return HandoffContextReferenceSchema.parse({
    namespace: HANDOFF_NAMESPACE,
    id: entry.id,
    revision: item.revision,
    sizeBytes: item.sizeBytes,
    mediaType: entry.mediaType,
  });
}

function isSameRegistration(left: HandoffEntry, right: HandoffEntry): boolean {
  return (
    left.id === right.id &&
    left.invocationId === right.invocationId &&
    left.attemptId === right.attemptId &&
    left.mediaType === right.mediaType &&
    left.description === right.description &&
    JSON.stringify(left.source) === JSON.stringify(right.source)
  );
}

function assertContainedPath(root: string, target: string): void {
  const path = relative(root, target);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error("Handoff path escapes its authorized root.");
}

async function openRegularFile(path: string): Promise<{
  readonly handle: FileHandle;
  readonly stats: BigIntStats;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) throw new Error("Handoff source must be a regular file.");
    return { handle, stats };
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

async function validateUtf8File(path: string): Promise<void> {
  const { handle, stats } = await openRegularFile(path);
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    const buffer = Buffer.alloc(FILE_VALIDATION_CHUNK_BYTES);
    let position = 0;
    const sizeBytes = toSafeFileSize(stats.size);
    while (position < sizeBytes) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) break;
      position += bytesRead;
      decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
    }
    decoder.decode();
  } finally {
    await handle.close();
  }
}

async function writeBytesAtomic(path: string, bytes: Uint8Array): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600 });
  await rename(temporary, path);
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await writeBytesAtomic(path, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"));
}

function decodeUtf8Chunk(buffer: Buffer): {
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
  return { content: "", startIndex, endIndex };
}

function isUtf8ContinuationByte(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

function normalizeSearchText(value: string, caseSensitive: boolean | undefined): string {
  return caseSensitive === true ? value : value.toLocaleLowerCase();
}

function createSearchSnippet(line: string, matchAt: number, matchLength: number): string {
  if (line.length <= SEARCH_SNIPPET_CHARACTERS) return line;
  const padding = Math.max(0, Math.floor((SEARCH_SNIPPET_CHARACTERS - matchLength) / 2));
  const start = Math.max(0, matchAt - padding);
  const end = Math.min(line.length, start + SEARCH_SNIPPET_CHARACTERS);
  return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

function queryLength(query: string): number {
  return Math.max(1, query.length);
}

function toSafeFileSize(size: bigint): number {
  const value = Number(size);
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("Handoff file size exceeds the supported range.");
  }
  return value;
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ELOOP")
  );
}

function toErrorDetails(error: unknown): unknown {
  return error instanceof Error
    ? { name: error.name, message: error.message, stack: error.stack }
    : error;
}
