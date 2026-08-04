import { constants, type BigIntStats } from "node:fs";
import { open, readFile, realpath, type FileHandle } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

import {
  PragmaPaths,
  error,
  ok,
  readExecutionRunScope,
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
} from "@pragma/core";
import { z } from "zod";

export const LEGACY_EXECUTION_OUTPUT_NAMESPACE = "pragma.handoff";

const SEARCH_CHUNK_BYTES = 64 * 1024;
const SEARCH_SNIPPET_CHARACTERS = 1_024;

const LegacyExecutionOutputEntrySchema = z.object({
  id: z.string().min(1),
  invocationId: z.string().min(1),
  attemptId: z.string().min(1),
  source: z.discriminatedUnion("type", [
    z.object({
      type: z.literal("managed"),
      relativePath: z.string().min(1),
      sha256: z.string().length(64),
    }),
    z.object({
      type: z.literal("workspace"),
      workspaceRoot: z.string().min(1),
      relativePath: z.string().min(1),
    }),
  ]),
  mediaType: z.string().min(1),
  description: z.string().optional(),
  idempotencyKey: z.string().min(1),
  createdAt: z.string().datetime(),
});

const LegacyExecutionOutputManifestSchema = z.object({
  schemaVersion: z.literal("pragma.execution-handoffs/v2"),
  entries: z.array(LegacyExecutionOutputEntrySchema),
});

type LegacyExecutionOutputEntry = z.infer<typeof LegacyExecutionOutputEntrySchema>;

interface LegacyExecutionOutputMetadata {
  readonly id: string;
  readonly metadata: ExpertAgentContextItemMetadata;
  readonly revision: string;
  readonly etag: string;
  readonly sizeBytes: number;
}

export interface LegacyExecutionOutputContextStoreOptions {
  readonly pragmaHome: string;
  readonly resolveVisibleExecutionIds: (
    activeExecutionId: string | undefined,
  ) => Promise<readonly string[]> | readonly string[];
}

/** Read-only compatibility view for v8 `pragma.handoff` Context references. */
export class LegacyExecutionOutputContextStore implements ExpertAgentContextStore {
  private readonly paths: PragmaPaths;
  private readonly readers = new Map<string, LegacyExecutionOutputReader>();

  constructor(private readonly options: LegacyExecutionOutputContextStoreOptions) {
    this.paths = new PragmaPaths({ pragmaHome: options.pragmaHome });
  }

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    try {
      const readers = await this.resolveReaders(input.context);
      const conflict = findDuplicateId(
        await Promise.all(
          readers.map(async (reader) => ({
            executionId: reader.executionId,
            ids: await reader.listIds(),
          })),
        ),
      );
      if (conflict !== undefined) return duplicateContextError(conflict.id, conflict.executionIds);
      const results = await Promise.all(readers.map(async (reader) => await reader.listContext()));
      const summaries: ExpertAgentContextItemSummary[] = [];
      for (const result of results) {
        if (!result.ok) return result;
        summaries.push(...result.value);
      }
      return ok(summaries);
    } catch (caught) {
      return error(
        "store_error",
        "Failed to list legacy Execution outputs.",
        toErrorDetails(caught),
      );
    }
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    try {
      const matches: LegacyExecutionOutputReader[] = [];
      for (const reader of await this.resolveReaders(input.context)) {
        if (await reader.has(input.id)) matches.push(reader);
      }
      if (matches.length === 0) {
        return error("context_not_found", `Legacy Execution output not found: ${input.id}`);
      }
      if (matches.length > 1) {
        return duplicateContextError(
          input.id,
          matches.map((reader) => reader.executionId),
        );
      }
      return await matches[0]!.readContext(input);
    } catch (caught) {
      return error(
        "store_error",
        `Failed to read legacy Execution output: ${input.id}`,
        toErrorDetails(caught),
      );
    }
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    if (input.query.trim() === "") {
      return error("invalid_input", "Context search query must not be empty.");
    }
    try {
      const readers = await this.resolveReaders(input.context);
      const conflict = findDuplicateId(
        await Promise.all(
          readers.map(async (reader) => ({
            executionId: reader.executionId,
            ids: await reader.listIds(),
          })),
        ),
      );
      if (conflict !== undefined) return duplicateContextError(conflict.id, conflict.executionIds);
      const maxResults = Math.max(1, Math.trunc(input.maxResults ?? 20));
      const matches: ExpertAgentContextItemSearchMatch[] = [];
      for (const reader of readers.toReversed()) {
        const result = await reader.searchContext({
          ...input,
          maxResults: maxResults - matches.length,
        });
        if (!result.ok) return result;
        matches.push(...result.value);
        if (matches.length >= maxResults) break;
      }
      return ok(matches);
    } catch (caught) {
      return error(
        "store_error",
        "Failed to search legacy Execution outputs.",
        toErrorDetails(caught),
      );
    }
  }

  addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    void input;
    return readonlyError();
  }

  editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    void input;
    return readonlyError();
  }

  deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    void input;
    return readonlyError();
  }

  private async resolveReaders(
    context: ExpertAgentContextItemListInput["context"],
  ): Promise<readonly LegacyExecutionOutputReader[]> {
    const activeExecutionId = readExecutionRunScope(context).executionId;
    const visible = await this.options.resolveVisibleExecutionIds(activeExecutionId);
    const executionIds = [
      ...new Set(activeExecutionId === undefined ? visible : [...visible, activeExecutionId]),
    ];
    return executionIds.map((executionId) => {
      let reader = this.readers.get(executionId);
      if (reader === undefined) {
        reader = new LegacyExecutionOutputReader(executionId, this.paths);
        this.readers.set(executionId, reader);
      }
      return reader;
    });
  }
}

class LegacyExecutionOutputReader {
  constructor(
    readonly executionId: string,
    private readonly paths: PragmaPaths,
  ) {}

  async listIds(): Promise<readonly string[]> {
    return (await this.readManifest()).entries.map((entry) => entry.id);
  }

  async has(id: string): Promise<boolean> {
    return (await this.readManifest()).entries.some((entry) => entry.id === id);
  }

  async listContext(): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    const summaries = await Promise.all(
      (await this.readManifest()).entries.map(async (entry) => {
        const metadata = await this.readMetadata(entry);
        return metadata.ok ? metadata.value : undefined;
      }),
    );
    return ok(
      summaries.filter((item): item is LegacyExecutionOutputMetadata => item !== undefined),
    );
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
        return error("context_not_found", `Legacy Execution output not found: ${input.id}`);
      }
      const opened = await openRegularFile(await this.resolveEntryPath(entry));
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
      return ok({
        ...createMetadata(entry, opened.stats),
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
      return isNotFound(caught)
        ? error("context_not_found", `Legacy Execution output not found: ${input.id}`)
        : error(
            "store_error",
            `Failed to read legacy Execution output: ${input.id}`,
            toErrorDetails(caught),
          );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    const matches: ExpertAgentContextItemSearchMatch[] = [];
    const maxResults = Math.max(1, Math.trunc(input.maxResults ?? 20));
    for (const entry of (await this.readManifest()).entries) {
      if (
        input.scope !== "content" &&
        normalizeSearchText(entry.id, input.caseSensitive).includes(
          normalizeSearchText(input.query.trim(), input.caseSensitive),
        )
      ) {
        matches.push({ id: entry.id, matchType: "path", line: entry.id });
      }
      if (matches.length >= maxResults) break;
      if (input.scope !== "path") await this.searchEntry(entry, input, matches, maxResults);
      if (matches.length >= maxResults) break;
    }
    return ok(matches);
  }

  private async readMetadata(
    entry: LegacyExecutionOutputEntry,
  ): Promise<ExpertAgentContextResult<LegacyExecutionOutputMetadata>> {
    let handle: FileHandle | undefined;
    try {
      const opened = await openRegularFile(await this.resolveEntryPath(entry));
      handle = opened.handle;
      return ok(createMetadata(entry, opened.stats));
    } catch (caught) {
      return isNotFound(caught)
        ? error("context_not_found", `Legacy Execution output not found: ${entry.id}`)
        : error(
            "store_error",
            `Failed to inspect legacy Execution output: ${entry.id}`,
            toErrorDetails(caught),
          );
    } finally {
      await handle?.close().catch(() => undefined);
    }
  }

  private async searchEntry(
    entry: LegacyExecutionOutputEntry,
    input: ExpertAgentStoredContextItemSearchInput,
    matches: ExpertAgentContextItemSearchMatch[],
    maxResults: number,
  ): Promise<void> {
    let handle: FileHandle | undefined;
    try {
      const opened = await openRegularFile(await this.resolveEntryPath(entry));
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
                line: createSearchSnippet(combined.replace(/\r$/u, ""), matchAt, needle.length),
              });
              matchedLine = true;
            }
          }
          if (completeLine) {
            lineNumber += 1;
            lineTail = "";
            matchedLine = false;
          } else {
            lineTail = combined.slice(-Math.max(needle.length - 1, 1));
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

  private async resolveEntryPath(entry: LegacyExecutionOutputEntry): Promise<string> {
    if (entry.source.type === "managed") {
      const root = resolve(this.paths.executionHandoffsRoot(this.executionId));
      const path = resolve(root, entry.source.relativePath);
      assertContainedPath(root, path);
      return path;
    }
    const storedRoot = resolve(entry.source.workspaceRoot);
    const currentRoot = await realpath(storedRoot);
    if (currentRoot !== storedRoot) {
      throw new Error("Legacy workspace root identity changed after registration.");
    }
    const candidate = resolve(storedRoot, entry.source.relativePath);
    assertContainedPath(storedRoot, candidate);
    const path = await realpath(candidate);
    assertContainedPath(storedRoot, path);
    return path;
  }

  private async readManifest() {
    try {
      return LegacyExecutionOutputManifestSchema.parse(
        JSON.parse(await readFile(this.paths.executionHandoffsManifest(this.executionId), "utf8")),
      );
    } catch (caught) {
      if (isNotFound(caught)) {
        return { schemaVersion: "pragma.execution-handoffs/v2" as const, entries: [] };
      }
      throw caught;
    }
  }
}

function readonlyError<TValue>(): Promise<ExpertAgentContextResult<TValue>> {
  return Promise.resolve(error("permission_denied", "Legacy Execution outputs are read-only."));
}

function findDuplicateId(
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
  return error("context_conflict", `Legacy Execution output id is ambiguous: ${id}`, {
    id,
    executionIds,
  });
}

function createMetadata(
  entry: LegacyExecutionOutputEntry,
  stats: BigIntStats,
): LegacyExecutionOutputMetadata {
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
    sizeBytes: toSafeFileSize(stats.size),
  };
}

function assertContainedPath(root: string, target: string): void {
  const path = relative(root, target);
  if (path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path))) return;
  throw new Error("Legacy Execution output path escapes its authorized root.");
}

async function openRegularFile(path: string): Promise<{
  readonly handle: FileHandle;
  readonly stats: BigIntStats;
}> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = await handle.stat({ bigint: true });
    if (!stats.isFile()) throw new Error("Legacy Execution output must be a regular file.");
    return { handle, stats };
  } catch (caught) {
    await handle.close().catch(() => undefined);
    throw caught;
  }
}

function decodeUtf8Chunk(buffer: Buffer): {
  readonly content: string;
  readonly startIndex: number;
  readonly endIndex: number;
} {
  let startIndex = 0;
  let endIndex = buffer.length;
  while (startIndex < endIndex && ((buffer[startIndex] ?? 0) & 0xc0) === 0x80) startIndex += 1;
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

function normalizeSearchText(value: string, caseSensitive: boolean | undefined): string {
  return caseSensitive === true ? value : value.toLocaleLowerCase();
}

function createSearchSnippet(line: string, matchAt: number, matchLength: number): string {
  if (line.length <= SEARCH_SNIPPET_CHARACTERS) return line;
  const start = Math.max(0, matchAt - Math.floor(SEARCH_SNIPPET_CHARACTERS / 2));
  return line.slice(
    start,
    Math.min(line.length, start + Math.max(SEARCH_SNIPPET_CHARACTERS, matchLength)),
  );
}

function toSafeFileSize(size: bigint): number {
  if (size > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error("Legacy Execution output is too large.");
  return Number(size);
}

function isNotFound(caught: unknown): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    (caught as { readonly code?: unknown }).code === "ENOENT"
  );
}

function toErrorDetails(caught: unknown): { readonly message: string } {
  return { message: caught instanceof Error ? caught.message : String(caught) };
}
