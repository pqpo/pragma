import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  ExpertAgentContextItemListInput,
  ExpertAgentContextItemMetadata,
  ExpertAgentContextResult,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSummary,
  ExpertAgentContextStore,
  ExpertAgentStoredContextItem,
  ExpertAgentStoredContextItemEditResult,
  ExpertAgentStoredContextItemReadResult,
  ExpertAgentStoredContextRegisterInput,
  ExpertAgentStoredContextItemDeleteInput,
  ExpertAgentStoredContextItemEditInput,
  ExpertAgentStoredContextItemReadInput,
  ExpertAgentStoredContextItemSearchInput,
} from "./context-system.ts";
import {
  error,
  matchContextPattern,
  normalizeMetadata,
  normalizePriority,
  normalizeTrigger,
  ok,
} from "./context-system.ts";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const matter = require("gray-matter") as typeof import("gray-matter");

export interface FileSystemContextStoreCommandResult {
  readonly stdout: string;
}

export type FileSystemContextStoreCommandRunner = (
  command: string,
  args: readonly string[],
) => Promise<FileSystemContextStoreCommandResult>;

export interface FileSystemContextStoreOptions {
  readonly rootDir: string;
  readonly commandRunner?: FileSystemContextStoreCommandRunner | undefined;
  readonly maxContextBytes?: number | undefined;
  readonly include?: readonly string[] | undefined;
  readonly exclude?: readonly string[] | undefined;
  readonly maxFrontmatterBytes?: number | undefined;
  readonly authorize?: FileSystemContextStoreAuthorizer | undefined;
}

export type FileSystemContextStoreOperation =
  | "list"
  | "read"
  | "search"
  | "add"
  | "edit"
  | "delete";

export type FileSystemContextStoreAuthorizer = (input: {
  readonly operation: FileSystemContextStoreOperation;
  readonly ids: readonly string[];
  readonly context?: ExpertAgentStoredContextItemReadInput["context"] | undefined;
}) => readonly string[] | Promise<readonly string[]>;

export class FileSystemContextStore implements ExpertAgentContextStore {
  readonly rootDir: string;
  readonly maxContextBytes: number | undefined;
  readonly include: readonly string[];
  readonly exclude: readonly string[];
  readonly maxFrontmatterBytes: number;
  private readonly commandRunner: FileSystemContextStoreCommandRunner;
  private readonly authorize: FileSystemContextStoreAuthorizer | undefined;
  private readonly mutations = new Map<string, Promise<void>>();

  constructor(options: FileSystemContextStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxContextBytes = options.maxContextBytes;
    this.include = options.include ?? ["*.md", "**/*.md"];
    this.exclude = options.exclude ?? [];
    this.maxFrontmatterBytes = Math.max(1, Math.trunc(options.maxFrontmatterBytes ?? 64 * 1024));
    this.commandRunner = options.commandRunner ?? runSearchCommand;
    this.authorize = options.authorize;
  }

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    try {
      const files = await collectContextFiles(this.rootDir, (id) => this.isAllowedId(id));
      const authorizedIds = await this.authorizeIds(
        "list",
        files.map((filePath) => toContextId(this.rootDir, filePath)),
        input.context,
      );
      const context = await Promise.all(
        files
          .filter((filePath) => authorizedIds.has(toContextId(this.rootDir, filePath)))
          .map(async (filePath) => {
            return await readFileContextSummary(this.rootDir, filePath, this.maxFrontmatterBytes);
          }),
      );

      return ok(context);
    } catch (caught) {
      return error("store_error", "Failed to list file system context.", toErrorDetails(caught));
    }
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    try {
      const denied = await this.checkAuthorization("read", input.id, input.context);

      if (denied !== undefined) {
        return denied;
      }

      const filePath = await this.resolveExistingContextPath(input.id);

      if (filePath === undefined) {
        return error("context_not_found", `Context not found: ${input.id}`, { id: input.id });
      }

      const context = await readFileContext(this.rootDir, filePath);
      const read = readContentRange(context.content, {
        start: input.start ?? 0,
        offset: input.offset,
      });
      const lineRange = calculateLineRange(context.content, {
        startOffset: read.startOffset,
        endOffset: read.endOffset,
      });

      return ok({
        id: input.id,
        content: read.content,
        metadata: context.metadata,
        revision: context.revision,
        etag: context.etag,
        sizeBytes: context.sizeBytes,
        contentRange: {
          requestedStartOffset: read.requestedStartOffset,
          startOffset: read.startOffset,
          endOffset: read.endOffset,
          nextStartOffset: read.nextStartOffset,
          truncated: read.truncated,
          sizeBytes: context.sizeBytes,
          ...(input.offset === undefined
            ? {}
            : { maxBytes: Math.max(1, Math.trunc(input.offset)) }),
          startLine: lineRange.startLine,
          endLine: lineRange.endLine,
          totalLines: lineRange.totalLines,
        },
      });
    } catch (caught) {
      return error("store_error", `Failed to read context: ${input.id}`, toErrorDetails(caught));
    }
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    try {
      const denied = await this.checkAuthorization("add", input.id, input.context);

      if (denied !== undefined) {
        return denied;
      }

      return await this.withMutationLock(input.id, async () => {
        const metadata = normalizeMetadata(input.id, normalizeInputMetadata(input.metadata));
        const metadataError = validateFileMetadata(input.id, metadata);

        if (metadataError !== undefined) {
          return metadataError;
        }

        const sizeError = validateContextSize(input.content, this.maxContextBytes);

        if (sizeError !== undefined) {
          return sizeError;
        }

        const filePath = await this.prepareNewContextPath(input.id);
        const context = { id: input.id, content: input.content, metadata };

        try {
          await writeFile(filePath, serializeFileContext(context), {
            encoding: "utf8",
            flag: "wx",
          });
        } catch (caught) {
          if (isNodeError(caught, "EEXIST")) {
            return error("context_already_exists", `Context already exists: ${input.id}`, {
              id: input.id,
            });
          }

          throw caught;
        }

        return ok(await readFileContext(this.rootDir, filePath));
      });
    } catch (caught) {
      return error(
        "store_error",
        `Failed to register context: ${input.id}`,
        toErrorDetails(caught),
      );
    }
  }

  async editContext(
    input: ExpertAgentStoredContextItemEditInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemEditResult>> {
    try {
      const denied = await this.checkAuthorization("edit", input.id, input.context);

      if (denied !== undefined) {
        return denied;
      }

      return await this.withMutationLock(input.id, async () => {
        const filePath = await this.resolveExistingContextPath(input.id);

        if (filePath === undefined) {
          return error("context_not_found", `Context not found: ${input.id}`, { id: input.id });
        }

        const [existing, existingStats] = await Promise.all([
          readFileContext(this.rootDir, filePath),
          stat(filePath),
        ]);
        const conflict = validateExpectedRevision(existing, input);

        if (conflict !== undefined) {
          return conflict;
        }

        let content: string;
        let metadata = existing.metadata;
        let replacementCount: number | undefined;

        if (input.mode === "replace") {
          content = input.content ?? existing.content;
          metadata =
            input.metadata === undefined
              ? existing.metadata
              : normalizeMetadata(input.id, normalizeInputMetadata(input.metadata));
        } else {
          const matches = existing.content.split(input.search).length - 1;

          if (matches === 0) {
            return error("invalid_input", `Context edit search did not match: ${input.id}`, {
              id: input.id,
              search: input.search,
            });
          }

          if (matches > 1 && input.replaceAll !== true) {
            return error(
              "invalid_input",
              `Context edit search matched multiple locations: ${input.id}`,
              {
                id: input.id,
                search: input.search,
                replacementCount: matches,
              },
            );
          }

          content =
            input.replaceAll === true
              ? existing.content.split(input.search).join(input.replace)
              : existing.content.replace(input.search, input.replace);
          replacementCount = input.replaceAll === true ? matches : 1;
        }

        const sizeError = validateContextSize(content, this.maxContextBytes);

        if (sizeError !== undefined) {
          return sizeError;
        }

        const metadataError = validateFileMetadata(input.id, metadata);

        if (metadataError !== undefined) {
          return metadataError;
        }

        await writeFileAtomically(
          filePath,
          serializeFileContext({ id: input.id, content, metadata }),
          {
            mode: existingStats.mode,
            uid: existingStats.uid,
            gid: existingStats.gid,
          },
        );
        const updated = await readFileContext(this.rootDir, filePath);

        return ok({
          ...updated,
          mode: input.mode,
          ...(replacementCount === undefined ? {} : { replacementCount }),
        });
      });
    } catch (caught) {
      return error("store_error", `Failed to edit context: ${input.id}`, toErrorDetails(caught));
    }
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    try {
      const denied = await this.checkAuthorization("delete", input.id, input.context);

      if (denied !== undefined) {
        return denied;
      }

      return await this.withMutationLock(input.id, async () => {
        const filePath = await this.resolveExistingContextPath(input.id);

        if (filePath === undefined) {
          return error("context_not_found", `Context not found: ${input.id}`, { id: input.id });
        }

        await rm(filePath);

        return ok({ id: input.id });
      });
    } catch (caught) {
      return error("store_error", `Failed to delete context: ${input.id}`, toErrorDetails(caught));
    }
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    try {
      const files = await collectContextFiles(this.rootDir, (id) => this.isAllowedId(id));

      if (files.length === 0) {
        return ok([]);
      }

      if (input.scope === "path") {
        return ok(
          await this.authorizeSearchMatches(
            await searchContextPaths(this.rootDir, input, files),
            input,
          ),
        );
      }

      let contentMatches: readonly ExpertAgentContextItemSearchMatch[];
      const ripgrepResult = await searchContextWithRipgrep(
        this.rootDir,
        input,
        this.commandRunner,
        files,
      );

      if (ripgrepResult.ok) {
        contentMatches = withContentMatchType(
          ripgrepResult.matches.filter((match) => this.isAllowedId(match.id)),
        );
      } else {
        const grepResult = await searchContextWithGrep(
          this.rootDir,
          input,
          this.commandRunner,
          files,
        );

        contentMatches = grepResult.ok
          ? withContentMatchType(grepResult.matches.filter((match) => this.isAllowedId(match.id)))
          : withContentMatchType(await searchContextWithFileReads(this.rootDir, input, files));
      }

      const matches =
        input.scope === "hybrid"
          ? mergeSearchMatches(contentMatches, await searchContextPaths(this.rootDir, input, files))
          : contentMatches;

      return ok(await this.authorizeSearchMatches(matches, input));
    } catch (caught) {
      return error("store_error", "Failed to search file system context.", toErrorDetails(caught));
    }
  }

  private async authorizeSearchMatches(
    matches: readonly ExpertAgentContextItemSearchMatch[],
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<readonly ExpertAgentContextItemSearchMatch[]> {
    const authorizedIds = await this.authorizeIds(
      "search",
      matches.map((match) => match.id),
      input.context,
    );

    return matches.filter((match) => authorizedIds.has(match.id)).slice(0, input.maxResults ?? 20);
  }

  private async authorizeIds(
    operation: FileSystemContextStoreOperation,
    ids: readonly string[],
    context: ExpertAgentStoredContextItemReadInput["context"],
  ): Promise<ReadonlySet<string>> {
    const requestedIds = [...new Set(ids)];

    if (this.authorize === undefined) {
      return new Set(requestedIds);
    }

    const requestedIdSet = new Set(requestedIds);
    const authorizedIds = await this.authorize({ operation, ids: requestedIds, context });

    return new Set(authorizedIds.filter((id) => requestedIdSet.has(id)));
  }

  private resolveContextPath(id: string): string {
    if (!this.isAllowedId(id)) {
      throw new Error(`Context id is not allowed by include/exclude rules: ${id}`);
    }

    const filePath = resolve(this.rootDir, id);
    const relativePath = relative(this.rootDir, filePath);

    if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith(sep)) {
      throw new Error(`Invalid context id: ${id}`);
    }

    return filePath;
  }

  private isAllowedId(id: string): boolean {
    return (
      this.include.some((pattern) => matchContextPattern(id, pattern)) &&
      !this.exclude.some((pattern) => matchContextPattern(id, pattern))
    );
  }

  private async resolveExistingContextPath(id: string): Promise<string | undefined> {
    const filePath = this.resolveContextPath(id);

    if (!(await exists(filePath))) {
      return undefined;
    }

    const fileStats = await lstat(filePath);

    if (fileStats.isSymbolicLink() || !fileStats.isFile()) {
      throw new Error(`Context id must resolve to a regular file: ${id}`);
    }

    const [canonicalRoot, canonicalFile] = await Promise.all([
      realpath(this.rootDir),
      realpath(filePath),
    ]);
    assertContainedPath(canonicalRoot, canonicalFile, id);

    return filePath;
  }

  private async prepareNewContextPath(id: string): Promise<string> {
    const filePath = this.resolveContextPath(id);
    const root = await realpath(this.rootDir);
    const relativeParent = relative(this.rootDir, dirname(filePath));
    let current = root;

    for (const segment of relativeParent
      .split(sep)
      .filter((part) => part.length > 0 && part !== ".")) {
      const next = resolve(current, segment);

      if (await exists(next)) {
        const nextStats = await lstat(next);

        if (nextStats.isSymbolicLink() || !nextStats.isDirectory()) {
          throw new Error(`Context parent must be a real directory: ${id}`);
        }
      } else {
        await mkdir(next);
      }

      const canonicalNext = await realpath(next);
      assertContainedPath(root, canonicalNext, id);
      current = canonicalNext;
    }

    return filePath;
  }

  private async withMutationLock<TValue>(
    id: string,
    operation: () => Promise<TValue>,
  ): Promise<TValue> {
    const previous = this.mutations.get(id) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const current = new Promise<void>((resolveLock) => {
      release = resolveLock;
    });
    const queued = previous.then(() => current);
    this.mutations.set(id, queued);
    await previous;

    try {
      return await operation();
    } finally {
      release?.();

      if (this.mutations.get(id) === queued) {
        this.mutations.delete(id);
      }
    }
  }

  private async checkAuthorization(
    operation: FileSystemContextStoreOperation,
    id: string,
    context: ExpertAgentStoredContextItemReadInput["context"],
  ): Promise<ExpertAgentContextResult<never> | undefined> {
    if ((await this.authorizeIds(operation, [id], context)).has(id)) {
      return undefined;
    }

    return error("permission_denied", `Context operation is not authorized: ${operation}`, {
      operation,
      id,
    });
  }
}

function withContentMatchType(
  matches: readonly ExpertAgentContextItemSearchMatch[],
): readonly ExpertAgentContextItemSearchMatch[] {
  return matches.map((match) => ({
    ...match,
    matchType: match.matchType ?? "content",
  }));
}

function calculateLineRange(
  content: string,
  options: {
    readonly startOffset: number;
    readonly endOffset: number;
  },
): {
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
} {
  const fullBuffer = Buffer.from(content, "utf8");
  const prefix = fullBuffer.subarray(0, options.startOffset).toString("utf8");
  const range = fullBuffer.subarray(options.startOffset, options.endOffset).toString("utf8");
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

function validateExpectedRevision(
  existing: ExpertAgentStoredContextItem,
  input: ExpertAgentStoredContextItemEditInput,
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

function validateFileMetadata(
  id: string,
  metadata: ExpertAgentContextItemMetadata,
): ExpertAgentContextResult<never> | undefined {
  if (
    isMarkdownId(id) ||
    (metadata.description === undefined &&
      metadata.trigger === "model_decision" &&
      metadata.trustLevel === undefined &&
      metadata.sensitivity === undefined &&
      metadata.priority === "normal")
  ) {
    return undefined;
  }

  return error(
    "invalid_input",
    "FileSystemContextStore metadata is only supported for Markdown context.",
    { id },
  );
}

function createFileRevision(mtimeNs: bigint, sizeBytes: bigint): string {
  return `${mtimeNs}:${sizeBytes}`;
}

async function readFileContext(
  rootDir: string,
  filePath: string,
): Promise<ExpertAgentStoredContextItem> {
  const [stats, rawContent] = await Promise.all([
    stat(filePath, { bigint: true }),
    readUtf8File(filePath),
  ]);
  const id = toContextId(rootDir, filePath);
  const parsed = parseFileContext(id, rawContent);
  const sizeBytes = Buffer.byteLength(parsed.content, "utf8");
  const revision = createFileRevision(stats.mtimeNs, stats.size);

  return {
    id,
    content: parsed.content,
    metadata: parsed.metadata,
    revision,
    etag: revision,
    sizeBytes,
  };
}

async function readFileContextSummary(
  rootDir: string,
  filePath: string,
  maxFrontmatterBytes: number,
): Promise<ExpertAgentContextItemSummary> {
  const stats = await stat(filePath, { bigint: true });
  const id = toContextId(rootDir, filePath);
  const revision = createFileRevision(stats.mtimeNs, stats.size);
  const fileSize = Number(stats.size);

  if (!isMarkdownId(id)) {
    return {
      id,
      metadata: normalizeMetadata(id, {}),
      revision,
      etag: revision,
      sizeBytes: fileSize,
    };
  }

  const frontmatter = await readFrontmatter(filePath, fileSize, maxFrontmatterBytes);

  return {
    id,
    metadata: normalizeMetadata(id, frontmatter.metadata),
    revision,
    etag: revision,
    sizeBytes: Math.max(0, fileSize - frontmatter.contentStartBytes),
  };
}

async function readFrontmatter(
  filePath: string,
  fileSize: number,
  maxBytes: number,
): Promise<{
  readonly metadata: Partial<ExpertAgentContextItemMetadata>;
  readonly contentStartBytes: number;
}> {
  const handle = await open(filePath, "r");

  try {
    const openingBuffer = Buffer.alloc(Math.min(fileSize, 5));
    const opening = await handle.read(openingBuffer, 0, openingBuffer.length, 0);
    const openingText = openingBuffer.subarray(0, opening.bytesRead).toString("utf8");

    if (!openingText.startsWith("---\n") && !openingText.startsWith("---\r\n")) {
      return { metadata: {}, contentStartBytes: 0 };
    }

    const buffer = Buffer.alloc(Math.min(fileSize, maxBytes));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const prefix = buffer.subarray(0, bytesRead).toString("utf8");

    const match = /^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/.exec(prefix);

    if (match === null) {
      throw new Error(`Markdown frontmatter exceeds ${maxBytes} bytes or is not terminated.`);
    }

    return {
      metadata: parseMatterMetadata(matter(match[0]).data),
      contentStartBytes: Buffer.byteLength(match[0], "utf8"),
    };
  } finally {
    await handle.close();
  }
}

function readContentRange(
  content: string,
  options: {
    readonly start: number;
    readonly offset?: number | undefined;
  },
): {
  readonly content: string;
  readonly requestedStartOffset: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly nextStartOffset: number;
  readonly truncated: boolean;
} {
  const buffer = Buffer.from(content, "utf8");
  const sizeBytes = buffer.byteLength;
  const requestedStartOffset = Math.min(sizeBytes, Math.max(0, Math.trunc(options.start)));
  const availableBytes = Math.max(0, sizeBytes - requestedStartOffset);
  const bytesToRead =
    options.offset === undefined
      ? availableBytes
      : Math.min(availableBytes, Math.max(0, Math.trunc(options.offset)));

  if (bytesToRead === 0) {
    return {
      content: "",
      requestedStartOffset,
      startOffset: requestedStartOffset,
      endOffset: requestedStartOffset,
      nextStartOffset: requestedStartOffset,
      truncated: requestedStartOffset < sizeBytes,
    };
  }

  const decoded = decodeUtf8Range(
    buffer.subarray(requestedStartOffset, requestedStartOffset + bytesToRead),
  );
  const startOffset = requestedStartOffset + decoded.startIndex;
  const endOffset = requestedStartOffset + decoded.endIndex;

  return {
    content: decoded.content,
    requestedStartOffset,
    startOffset,
    endOffset,
    nextStartOffset: endOffset,
    truncated: endOffset < sizeBytes,
  };
}

function parseFileContext(
  id: string,
  rawContent: string,
): {
  readonly metadata: ExpertAgentContextItemMetadata;
  readonly content: string;
} {
  if (!isMarkdownId(id)) {
    return {
      metadata: normalizeMetadata(id, {}),
      content: rawContent,
    };
  }

  const parsed = matter(rawContent);

  return {
    metadata: normalizeMetadata(id, parseMatterMetadata(parsed.data)),
    content: parsed.content,
  };
}

function parseMatterMetadata(data: Record<string, unknown>): ExpertAgentContextItemMetadata {
  const description = data.description;
  const trigger = data.trigger;
  const trustLevel = data.trustLevel;
  const sensitivity = data.sensitivity;
  const priority = data.priority;

  return {
    ...(typeof description === "string" ? { description } : {}),
    trigger: normalizeTrigger(readMetadataTrigger(trigger)),
    ...(typeof trustLevel === "string" ? { trustLevel: normalizeTrustLevel(trustLevel) } : {}),
    ...(typeof sensitivity === "string" ? { sensitivity: normalizeSensitivity(sensitivity) } : {}),
    priority: typeof priority === "string" ? normalizePriority(priority) : "normal",
  };
}

function serializeFileContext(context: ExpertAgentStoredContextItem): string {
  if (!isMarkdownId(context.id)) {
    return context.content;
  }

  const serialized = matter.stringify(context.content, {
    ...(context.metadata.description === undefined
      ? {}
      : { description: context.metadata.description }),
    trigger: context.metadata.trigger,
    ...(context.metadata.trustLevel === undefined
      ? {}
      : { trustLevel: context.metadata.trustLevel }),
    ...(context.metadata.sensitivity === undefined
      ? {}
      : { sensitivity: context.metadata.sensitivity }),
    priority: context.metadata.priority,
  });

  if (!context.content.endsWith("\n") && serialized.endsWith("\n")) {
    return serialized.slice(0, -1);
  }

  return serialized;
}

function normalizeInputMetadata(
  metadata: Partial<ExpertAgentContextItemMetadata> | undefined,
): ExpertAgentContextItemMetadata {
  return {
    ...(metadata?.description === undefined ? {} : { description: metadata.description }),
    trigger: metadata?.trigger ?? "model_decision",
    ...(metadata?.trustLevel === undefined ? {} : { trustLevel: metadata.trustLevel }),
    ...(metadata?.sensitivity === undefined ? {} : { sensitivity: metadata.sensitivity }),
    priority: metadata?.priority ?? "normal",
  };
}

function normalizeTrustLevel(
  value: string | undefined,
): ExpertAgentContextItemMetadata["trustLevel"] {
  if (value === "system" || value === "workspace" || value === "user" || value === "external") {
    return value;
  }

  return "workspace";
}

function normalizeSensitivity(
  value: string | undefined,
): ExpertAgentContextItemMetadata["sensitivity"] {
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

function readMetadataTrigger(
  value: unknown,
): ExpertAgentContextItemMetadata["trigger"] | undefined {
  if (value === "always_on" || value === "model_decision" || value === "manual") {
    return value;
  }

  return undefined;
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

async function searchContextWithRipgrep(
  rootDir: string,
  input: ExpertAgentStoredContextItemSearchInput,
  commandRunner: FileSystemContextStoreCommandRunner,
  files: readonly string[],
): Promise<
  | {
      readonly ok: true;
      readonly matches: readonly ExpertAgentContextItemSearchMatch[];
    }
  | {
      readonly ok: false;
    }
> {
  const args = [
    "--json",
    "--fixed-strings",
    "--line-number",
    "--color",
    "never",
    "--context",
    String(input.contextLines ?? 0),
    ...(input.caseSensitive === true ? [] : ["--ignore-case"]),
    "--",
    input.query,
    ...files,
  ];

  try {
    const result = await commandRunner("rg", args);

    return {
      ok: true,
      matches: parseRipgrepJsonLines(rootDir, result.stdout),
    };
  } catch (caught) {
    if (isCommandExit(caught, 1)) {
      return {
        ok: true,
        matches: [],
      };
    }

    return {
      ok: false,
    };
  }
}

async function searchContextPaths(
  rootDir: string,
  input: ExpertAgentStoredContextItemSearchInput,
  files: readonly string[],
): Promise<readonly ExpertAgentContextItemSearchMatch[]> {
  const matches: ExpertAgentContextItemSearchMatch[] = [];
  const query = input.caseSensitive === true ? input.query : input.query.toLowerCase();

  for (const filePath of files) {
    const id = toContextId(rootDir, filePath);
    const candidate = input.caseSensitive === true ? id : id.toLowerCase();

    if (!candidate.includes(query) && !matchContextPattern(id, input.query, input.caseSensitive)) {
      continue;
    }

    matches.push({
      id,
      matchType: "path",
      line: id,
    });
  }

  return matches;
}

function mergeSearchMatches(
  left: readonly ExpertAgentContextItemSearchMatch[],
  right: readonly ExpertAgentContextItemSearchMatch[],
): readonly ExpertAgentContextItemSearchMatch[] {
  const merged: ExpertAgentContextItemSearchMatch[] = [...left];
  const seen = new Set(
    left.map(
      (match) =>
        `${match.id}:${match.matchType ?? "content"}:${match.lineNumber ?? 0}:${match.line}`,
    ),
  );

  for (const match of right) {
    const key = `${match.id}:${match.matchType ?? "content"}:${match.lineNumber ?? 0}:${match.line}`;

    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    merged.push(match);
  }

  return merged;
}

async function searchContextWithGrep(
  rootDir: string,
  input: ExpertAgentStoredContextItemSearchInput,
  commandRunner: FileSystemContextStoreCommandRunner,
  files: readonly string[],
): Promise<
  | {
      readonly ok: true;
      readonly matches: readonly ExpertAgentContextItemSearchMatch[];
    }
  | {
      readonly ok: false;
    }
> {
  const args = [
    "--line-number",
    "--fixed-strings",
    "--with-filename",
    "-I",
    ...(input.caseSensitive === true ? [] : ["--ignore-case"]),
    "--",
    input.query,
    ...files,
  ];

  try {
    const result = await commandRunner("grep", args);

    return {
      ok: true,
      matches: await parseGrepLines(rootDir, result.stdout, input),
    };
  } catch (caught) {
    if (isCommandExit(caught, 1)) {
      return {
        ok: true,
        matches: [],
      };
    }

    return {
      ok: false,
    };
  }
}

function parseRipgrepJsonLines(
  rootDir: string,
  stdout: string,
): readonly ExpertAgentContextItemSearchMatch[] {
  const matches: ExpertAgentContextItemSearchMatch[] = [];
  const beforeByPath = new Map<string, string[]>();
  let currentMatch: ExpertAgentContextItemSearchMatch | undefined;

  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    const event = JSON.parse(line) as RipgrepJsonEvent;

    if (event.type === "context") {
      const contextLine = readRipgrepText(event.data.lines);
      const path = readRipgrepText(event.data.path);
      const id = toContextId(rootDir, path);

      if (currentMatch !== undefined && id === currentMatch.id) {
        currentMatch = appendSearchMatchAfter(currentMatch, contextLine);
        matches[matches.length - 1] = currentMatch;
      } else {
        beforeByPath.set(path, [...(beforeByPath.get(path) ?? []), contextLine]);
      }

      continue;
    }

    if (event.type !== "match") {
      continue;
    }

    const filePath = readRipgrepText(event.data.path);
    const id = toContextId(rootDir, filePath);
    const match = {
      id,
      lineNumber: event.data.line_number,
      line: trimLineEnd(readRipgrepText(event.data.lines)),
      before: beforeByPath.get(filePath)?.map(trimLineEnd),
    } satisfies ExpertAgentContextItemSearchMatch;

    matches.push(match);
    currentMatch = match;
    beforeByPath.delete(filePath);
  }

  return matches;
}

async function parseGrepLines(
  rootDir: string,
  stdout: string,
  input: ExpertAgentStoredContextItemSearchInput,
): Promise<readonly ExpertAgentContextItemSearchMatch[]> {
  const matches: ExpertAgentContextItemSearchMatch[] = [];
  const linesByPath = new Map<string, readonly string[]>();

  for (const line of stdout.split("\n")) {
    if (line.length === 0) {
      continue;
    }

    const parsed = parseGrepLine(line);

    if (parsed === undefined) {
      continue;
    }

    let contextLines = linesByPath.get(parsed.filePath);

    if (contextLines === undefined) {
      contextLines = (await readUtf8File(parsed.filePath)).split("\n");
      linesByPath.set(parsed.filePath, contextLines);
    }

    const lineIndex = parsed.lineNumber - 1;

    matches.push({
      id: toContextId(rootDir, parsed.filePath),
      lineNumber: parsed.lineNumber,
      line: trimLineEnd(contextLines[lineIndex] ?? parsed.line),
      before: readContextLines(contextLines, lineIndex - (input.contextLines ?? 0), lineIndex),
      after: readContextLines(
        contextLines,
        lineIndex + 1,
        lineIndex + 1 + (input.contextLines ?? 0),
      ),
    });
  }

  return matches;
}

function parseGrepLine(
  line: string,
): { readonly filePath: string; readonly lineNumber: number; readonly line: string } | undefined {
  const match = /^(?<filePath>.*):(?<lineNumber>\d+):(?<line>.*)$/.exec(line);

  if (match?.groups === undefined) {
    return undefined;
  }

  const { filePath, lineNumber, line: matchedLine } = match.groups;

  if (filePath === undefined || lineNumber === undefined || matchedLine === undefined) {
    return undefined;
  }

  return {
    filePath,
    lineNumber: Number.parseInt(lineNumber, 10),
    line: matchedLine,
  };
}

async function searchContextWithFileReads(
  rootDir: string,
  input: ExpertAgentStoredContextItemSearchInput,
  files: readonly string[],
): Promise<readonly ExpertAgentContextItemSearchMatch[]> {
  const matches: ExpertAgentContextItemSearchMatch[] = [];
  const query = input.caseSensitive === true ? input.query : input.query.toLowerCase();

  for (const filePath of files) {
    const content = await readUtf8File(filePath);
    const lines = content.split("\n");

    for (const [index, line] of lines.entries()) {
      const searchedLine = input.caseSensitive === true ? line : line.toLowerCase();

      if (!searchedLine.includes(query)) {
        continue;
      }

      matches.push({
        id: toContextId(rootDir, filePath),
        lineNumber: index + 1,
        line: trimLineEnd(line),
        before: readContextLines(lines, index - (input.contextLines ?? 0), index),
        after: readContextLines(lines, index + 1, index + 1 + (input.contextLines ?? 0)),
      });
    }
  }

  return matches;
}

function readContextLines(
  lines: readonly string[],
  start: number,
  end: number,
): readonly string[] | undefined {
  const context = lines.slice(Math.max(0, start), Math.max(0, end)).map(trimLineEnd);

  return context.length === 0 ? undefined : context;
}

function appendSearchMatchAfter(
  match: ExpertAgentContextItemSearchMatch,
  line: string,
): ExpertAgentContextItemSearchMatch {
  return {
    ...match,
    after: [...(match.after ?? []), trimLineEnd(line)],
  };
}

interface RipgrepJsonEvent {
  readonly type: string;
  readonly data: {
    readonly path: RipgrepJsonText;
    readonly lines: RipgrepJsonText;
    readonly line_number: number;
  };
}

interface RipgrepJsonText {
  readonly text?: string | undefined;
  readonly bytes?: string | undefined;
}

function readRipgrepText(value: RipgrepJsonText): string {
  if (value.text !== undefined) {
    return value.text;
  }

  if (value.bytes !== undefined) {
    return Buffer.from(value.bytes, "base64").toString("utf8");
  }

  return "";
}

function trimLineEnd(line: string): string {
  return line.replace(/\r?\n$/, "");
}

async function runSearchCommand(
  command: string,
  args: readonly string[],
): Promise<FileSystemContextStoreCommandResult> {
  const result = await execFileAsync(command, [...args], {
    maxBuffer: 10 * 1024 * 1024,
  });

  return {
    stdout: result.stdout,
  };
}

async function collectContextFiles(
  directory: string,
  isAllowed: (id: string) => boolean,
  rootDir: string = directory,
): Promise<string[]> {
  const directoryStat = await stat(directory);

  if (!directoryStat.isDirectory()) {
    return isAllowed(toContextId(rootDir, directory)) ? [directory] : [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return collectContextFiles(entryPath, isAllowed, rootDir);
      }

      if (entry.isFile() && isAllowed(toContextId(rootDir, entryPath))) {
        return [entryPath];
      }

      return [];
    }),
  );

  return nested.flat();
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readUtf8File(filePath: string): Promise<string> {
  const content = await readFile(filePath);
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

function toContextId(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
}

function isMarkdownId(id: string): boolean {
  return extname(id).toLowerCase() === ".md";
}

function assertContainedPath(rootDir: string, filePath: string, id: string): void {
  const relativePath = relative(rootDir, filePath);

  if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith(sep)) {
    throw new Error(`Context path escapes the configured root: ${id}`);
  }
}

async function writeFileAtomically(
  filePath: string,
  content: string,
  permissions: {
    readonly mode: number;
    readonly uid: number;
    readonly gid: number;
  },
): Promise<void> {
  const temporaryPath = resolve(dirname(filePath), `.${basename(filePath)}.${randomUUID()}.tmp`);

  try {
    await writeFile(temporaryPath, content, { encoding: "utf8", flag: "wx" });
    await chmod(temporaryPath, permissions.mode & 0o7777);
    const temporaryStats = await stat(temporaryPath);

    if (temporaryStats.uid !== permissions.uid || temporaryStats.gid !== permissions.gid) {
      await chown(temporaryPath, permissions.uid, permissions.gid);
    }

    await rename(temporaryPath, filePath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

function isNodeError(caught: unknown, code: string): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    (caught as { readonly code?: unknown }).code === code
  );
}

function toErrorDetails(caught: unknown): unknown {
  if (caught instanceof Error) {
    return {
      name: caught.name,
      message: caught.message,
    };
  }

  return caught;
}

function isCommandExit(caught: unknown, code: number): boolean {
  return (
    typeof caught === "object" &&
    caught !== null &&
    "code" in caught &&
    (caught as { readonly code: unknown }).code === code
  );
}
