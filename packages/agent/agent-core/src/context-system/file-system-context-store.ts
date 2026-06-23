import { execFile } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, extname, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import type {
  ExpertAgentContextItemDeleteInput,
  ExpertAgentContextItemListInput,
  ExpertAgentContextItemMetadata,
  ExpertAgentContextItemReadInput,
  ExpertAgentContextResult,
  ExpertAgentContextItemSearchInput,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSummary,
  ExpertAgentContextStore,
  ExpertAgentStoredContextItem,
  ExpertAgentStoredContextItemReadResult,
  ExpertAgentStoredContextRegisterInput,
  ExpertAgentStoredContextItemUpdateInput,
} from "./context-system.ts";
import {
  error,
  isAgentsContextId,
  normalizeMetadata,
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
}

export class FileSystemContextStore implements ExpertAgentContextStore {
  readonly rootDir: string;
  readonly maxContextBytes: number | undefined;
  private readonly commandRunner: FileSystemContextStoreCommandRunner;

  constructor(options: FileSystemContextStoreOptions) {
    this.rootDir = resolve(options.rootDir);
    this.maxContextBytes = options.maxContextBytes;
    this.commandRunner = options.commandRunner ?? runSearchCommand;
  }

  async listContext(
    input: ExpertAgentContextItemListInput = {},
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>> {
    void input;

    try {
      const files = await collectMarkdownFiles(this.rootDir);
      const context = await Promise.all(
        files.map(async (filePath) => {
          const context = await readMarkdownFileContext(this.rootDir, filePath);

          return {
            id: context.id,
            metadata: context.metadata,
            revision: context.revision,
            etag: context.etag,
            sizeBytes: context.sizeBytes,
          };
        }),
      );

      return ok(context);
    } catch (caught) {
      return error("store_error", "Failed to list file system context.", toErrorDetails(caught));
    }
  }

  async readContext(
    input: ExpertAgentContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    try {
      const filePath = this.resolveContextPath(input.id);

      if (!(await exists(filePath))) {
        return error("context_not_found", `Context not found: ${input.id}`, { id: input.id });
      }

      const context = await readMarkdownFileContext(this.rootDir, filePath);
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

  async registerContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    try {
      const metadata = normalizeMetadata(input.id, normalizeInputMetadata(input.metadata));
      const sizeError = validateContextSize(input.content, this.maxContextBytes);

      if (sizeError !== undefined) {
        return sizeError;
      }

      const filePath = this.resolveContextPath(input.id);

      if (await exists(filePath)) {
        return error("context_already_exists", `Context already exists: ${input.id}`, {
          id: input.id,
        });
      }

      const context = {
        id: input.id,
        content: input.content,
        metadata,
      };

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, serializeMarkdownContext(context), "utf8");

      return ok(await readMarkdownFileContext(this.rootDir, filePath));
    } catch (caught) {
      return error(
        "store_error",
        `Failed to register context: ${input.id}`,
        toErrorDetails(caught),
      );
    }
  }

  async updateContext(
    input: ExpertAgentStoredContextItemUpdateInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    try {
      const existing = await this.readContext({
        id: input.id,
        context: input.context,
      });

      if (!existing.ok) {
        return existing;
      }

      const conflict = validateExpectedRevision(existing.value, input);

      if (conflict !== undefined) {
        return conflict;
      }

      const content = input.content ?? existing.value.content;
      const metadata =
        input.metadata === undefined
          ? existing.value.metadata
          : normalizeMetadata(input.id, normalizeInputMetadata(input.metadata));
      const sizeError = validateContextSize(content, this.maxContextBytes);

      if (sizeError !== undefined) {
        return sizeError;
      }

      const context = {
        id: input.id,
        content,
        metadata,
      };
      const filePath = this.resolveContextPath(input.id);
      await writeFile(filePath, serializeMarkdownContext(context), "utf8");

      return ok(await readMarkdownFileContext(this.rootDir, filePath));
    } catch (caught) {
      return error("store_error", `Failed to update context: ${input.id}`, toErrorDetails(caught));
    }
  }

  async deleteContext(
    input: ExpertAgentContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    try {
      const filePath = this.resolveContextPath(input.id);

      if (!(await exists(filePath))) {
        return error("context_not_found", `Context not found: ${input.id}`, { id: input.id });
      }

      await rm(filePath);

      return ok({ id: input.id });
    } catch (caught) {
      return error("store_error", `Failed to delete context: ${input.id}`, toErrorDetails(caught));
    }
  }

  async searchContext(
    input: ExpertAgentContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    try {
      const ripgrepResult = await searchContextWithRipgrep(this.rootDir, input, this.commandRunner);

      if (ripgrepResult.ok) {
        return ok(ripgrepResult.matches);
      }

      const grepResult = await searchContextWithGrep(this.rootDir, input, this.commandRunner);

      if (grepResult.ok) {
        return ok(grepResult.matches);
      }

      return ok(await searchContextWithFileReads(this.rootDir, input));
    } catch (caught) {
      return error("store_error", "Failed to search file system context.", toErrorDetails(caught));
    }
  }

  private resolveContextPath(id: string): string {
    const filePath = resolve(this.rootDir, id);
    const relativePath = relative(this.rootDir, filePath);

    if (relativePath.startsWith("..") || relativePath === "" || relativePath.startsWith(sep)) {
      throw new Error(`Invalid context id: ${id}`);
    }

    return filePath;
  }
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
  input: ExpertAgentStoredContextItemUpdateInput,
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

function createFileRevision(mtimeMs: number, sizeBytes: number): string {
  return `${Math.trunc(mtimeMs)}:${Math.max(0, Math.trunc(sizeBytes))}`;
}

async function readMarkdownFileContext(
  rootDir: string,
  filePath: string,
): Promise<ExpertAgentStoredContextItem> {
  const [stats, rawContent] = await Promise.all([stat(filePath), readFile(filePath, "utf8")]);
  const id = toContextId(rootDir, filePath);
  const parsed = parseMarkdownContext(id, rawContent);
  const sizeBytes = Buffer.byteLength(parsed.content, "utf8");
  const revision = createFileRevision(stats.mtimeMs, stats.size);

  return {
    id,
    content: parsed.content,
    metadata: parsed.metadata,
    revision,
    etag: revision,
    sizeBytes,
  };
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

function parseMarkdownContext(
  id: string,
  rawContent: string,
): {
  readonly metadata: ExpertAgentContextItemMetadata;
  readonly content: string;
} {
  if (isAgentsContextId(id)) {
    return {
      metadata: normalizeMetadata(id, { trigger: "always_on" }),
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

  return {
    ...(typeof description === "string" ? { description } : {}),
    trigger: normalizeTrigger(readMetadataTrigger(trigger)),
    ...(typeof trustLevel === "string" ? { trustLevel: normalizeTrustLevel(trustLevel) } : {}),
    ...(typeof sensitivity === "string" ? { sensitivity: normalizeSensitivity(sensitivity) } : {}),
  };
}

function serializeMarkdownContext(context: ExpertAgentStoredContextItem): string {
  if (isAgentsContextId(context.id)) {
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
  input: ExpertAgentContextItemSearchInput,
  commandRunner: FileSystemContextStoreCommandRunner,
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
    "--glob",
    "*.md",
    "--context",
    String(input.contextLines ?? 0),
    ...(input.caseSensitive === true ? [] : ["--ignore-case"]),
    "--",
    input.query,
    rootDir,
  ];

  try {
    const result = await commandRunner("rg", args);

    return {
      ok: true,
      matches: parseRipgrepJsonLines(rootDir, result.stdout, input.maxResults ?? 20),
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

async function searchContextWithGrep(
  rootDir: string,
  input: ExpertAgentContextItemSearchInput,
  commandRunner: FileSystemContextStoreCommandRunner,
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
    "--recursive",
    "-I",
    ...(input.caseSensitive === true ? [] : ["--ignore-case"]),
    "--",
    input.query,
    rootDir,
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
  maxResults: number,
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

  return matches.slice(0, maxResults);
}

async function parseGrepLines(
  rootDir: string,
  stdout: string,
  input: ExpertAgentContextItemSearchInput,
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

    if (extname(parsed.filePath).toLowerCase() !== ".md") {
      continue;
    }

    let contextLines = linesByPath.get(parsed.filePath);

    if (contextLines === undefined) {
      contextLines = (await readFile(parsed.filePath, "utf8")).split("\n");
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

    if (matches.length >= (input.maxResults ?? 20)) {
      return matches;
    }
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
  input: ExpertAgentContextItemSearchInput,
): Promise<readonly ExpertAgentContextItemSearchMatch[]> {
  const files = await collectMarkdownFiles(rootDir);
  const matches: ExpertAgentContextItemSearchMatch[] = [];
  const query = input.caseSensitive === true ? input.query : input.query.toLocaleLowerCase();

  for (const filePath of files) {
    const content = await readFile(filePath, "utf8");
    const lines = content.split("\n");

    for (const [index, line] of lines.entries()) {
      const searchedLine = input.caseSensitive === true ? line : line.toLocaleLowerCase();

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

      if (matches.length >= (input.maxResults ?? 20)) {
        return matches;
      }
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

async function collectMarkdownFiles(directory: string): Promise<string[]> {
  const directoryStat = await stat(directory);

  if (!directoryStat.isDirectory()) {
    return extname(directory).toLowerCase() === ".md" ? [directory] : [];
  }

  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = resolve(directory, entry.name);

      if (entry.isDirectory()) {
        return collectMarkdownFiles(entryPath);
      }

      if (entry.isFile() && extname(entry.name).toLowerCase() === ".md") {
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

function toContextId(rootDir: string, filePath: string): string {
  return relative(rootDir, filePath).split(sep).join("/");
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
