import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import {
  HOST_CONTEXT_NAMESPACE,
  createExpertAgentPluginConfigEnvName,
  definePluginEntry,
  error,
  normalizeMetadata,
  ok,
} from "@pragma/core";
import type {
  ContextSensitivity,
  ExpertAgentContextItemMetadata,
  ExpertAgentContextItemSearchMatch,
  ExpertAgentContextItemSummary,
  ExpertAgentContextResult,
  ExpertAgentContextStore,
  ExpertAgentPluginSetupContext,
  ExpertAgentStoredContextItem,
  ExpertAgentStoredContextItemDeleteInput,
  ExpertAgentStoredContextItemReadInput,
  ExpertAgentStoredContextItemReadResult,
  ExpertAgentStoredContextItemSearchInput,
  ExpertAgentStoredContextItemUpdateInput,
  ExpertAgentStoredContextRegisterInput,
} from "@pragma/core";

import {
  MemoryLedgerSchema,
  MemoryPluginConfigSchema,
  MemoryTaskEvidenceSchema,
} from "./schema.ts";
import type { MemoryPluginConfig } from "./schema.ts";

export {
  MemoryLedgerSchema,
  MemoryPluginConfigSchema,
  MemoryTaskEvidenceSchema,
  parseMemoryPluginConfig,
} from "./schema.ts";

const MEMORY_CONTEXT_NAMESPACE = "expert-memory";
const PLUGIN_ID = "expert-memory";
const MEMORY_CONFIG_CONTEXT_ID = "memory-config.json";
const SUMMARY_CONTEXT_ID = "summary.md";
const MEMORY_CONTEXT_ID = "memory.md";
const TASKS_PREFIX = "tasks/";
const PENDING_PREFIX = "pending/";
const MARKDOWN_EXTENSION = ".md";

export default definePluginEntry({
  setup: (context) => {
    const store = createExpertMemoryStore(context);
    context.contextSystem.register({
      namespace: MEMORY_CONTEXT_NAMESPACE,
      store,
    });

    return {
      hooks: {
        afterTaskSubmit: async (taskContext) => {
          const config = await resolveConfig(context);

          if (!config.enabled || !config.generateMemories || taskContext.result === undefined) {
            return;
          }

          if (
            config.disableOnExternalContext &&
            taskContext.context?.attributes?.["externalContext"] === true
          ) {
            return;
          }

          const output = stringifyOutput(taskContext.result.result.output);
          const sourceText = `${taskContext.submission.query}\n${output}`;

          if (
            output.length < config.minRunOutputChars ||
            containsSensitiveContent(sourceText)
          ) {
            return;
          }

          await store.addContext({
            id: `${PENDING_PREFIX}${sanitizeIdSegment(taskContext.runId)}${MARKDOWN_EXTENSION}`,
            content: renderPendingMemoryCandidate({
              query: taskContext.submission.query,
              output,
              runId: taskContext.runId,
            }),
            metadata: {
              description: `Pending memory candidate for run ${taskContext.runId}.`,
              trigger: "manual",
              trustLevel: "workspace",
              sensitivity: "internal",
            },
            context: taskContext.context,
          });
        },
      },
    };
  },
});

function createExpertMemoryStore(context: ExpertAgentPluginSetupContext): ExpertAgentContextStore {
  return new FileSystemMemoryStore({
    agentId: context.agent?.id ?? "unknown-agent",
    context,
  });
}

class FileSystemMemoryStore implements ExpertAgentContextStore {
  private readonly agentId: string;
  private readonly context: ExpertAgentPluginSetupContext;

  constructor(options: {
    readonly agentId: string;
    readonly context: ExpertAgentPluginSetupContext;
  }) {
    this.agentId = options.agentId;
    this.context = options.context;
  }

  async listContext(): Promise<
    ExpertAgentContextResult<readonly ExpertAgentContextItemSummary[]>
  > {
    try {
      const config = await resolveConfig(this.context);

      if (!config.enabled || !config.useMemories) {
        return ok([]);
      }

      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const ids = await collectMemoryContextIds(rootDir);
      const summaries = await Promise.all(
        ids.map(async (id) => {
          const context = await readStoredContext(rootDir, id);

          return toSummary(context);
        }),
      );

      return ok(summaries);
    } catch (caught) {
      return error("store_error", "Failed to list expert memory.", toErrorDetails(caught));
    }
  }

  async readContext(
    input: ExpertAgentStoredContextItemReadInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItemReadResult>> {
    try {
      const config = await resolveConfig(this.context);

      if (!config.enabled || !config.useMemories) {
        return error("store_unavailable", "Expert memory is disabled.");
      }

      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      if (id.value === SUMMARY_CONTEXT_ID) {
        await regenerateSummary(rootDir, config, this.agentId);
      }

      const stored = await readStoredContext(rootDir, id.value);
      const range = readContentRange(stored.content, {
        start: input.start ?? 0,
        offset: input.offset,
      });
      const lineRange = calculateLineRange(stored.content, range.startOffset, range.endOffset);

      return ok({
        ...stored,
        content: range.content,
        contentRange: {
          requestedStartOffset: range.requestedStartOffset,
          startOffset: range.startOffset,
          endOffset: range.endOffset,
          nextStartOffset: range.nextStartOffset,
          truncated: range.truncated,
          sizeBytes: stored.sizeBytes,
          ...(input.offset === undefined ? {} : { maxBytes: Math.max(1, input.offset) }),
          startLine: lineRange.startLine,
          endLine: lineRange.endLine,
          totalLines: lineRange.totalLines,
        },
      });
    } catch (caught) {
      return error("context_not_found", `Expert memory context not found: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async addContext(
    input: ExpertAgentStoredContextRegisterInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    try {
      const config = await resolveConfig(this.context);
      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeWritableMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      const filePath = resolveContextPath(rootDir, id.value);

      if (await exists(filePath)) {
        return error("context_already_exists", `Expert memory context already exists: ${id.value}`);
      }

      const context = createStoredContext({
        id: id.value,
        content: input.content,
        metadata: input.metadata,
      });

      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, serializeMarkdown(context, this.agentId), "utf8");

      if (id.value === MEMORY_CONTEXT_ID) {
        await regenerateSummary(rootDir, config, this.agentId);
      }

      return ok(await readStoredContext(rootDir, id.value));
    } catch (caught) {
      return error("store_error", `Failed to add expert memory context: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async updateContext(
    input: ExpertAgentStoredContextItemUpdateInput,
  ): Promise<ExpertAgentContextResult<ExpertAgentStoredContextItem>> {
    try {
      const config = await resolveConfig(this.context);
      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeWritableMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      const existing = await readStoredContext(rootDir, id.value);
      const conflict = validateExpectedRevision(existing, input);

      if (conflict !== undefined) {
        return conflict;
      }

      const context = createStoredContext({
        id: id.value,
        content: input.content ?? existing.content,
        metadata: input.metadata ?? existing.metadata,
      });
      await writeFile(
        resolveContextPath(rootDir, id.value),
        serializeMarkdown(context, this.agentId),
        "utf8",
      );

      if (id.value === MEMORY_CONTEXT_ID) {
        await regenerateSummary(rootDir, config, this.agentId);
      }

      return ok(await readStoredContext(rootDir, id.value));
    } catch (caught) {
      return error("store_error", `Failed to update expert memory context: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async deleteContext(
    input: ExpertAgentStoredContextItemDeleteInput,
  ): Promise<ExpertAgentContextResult<{ readonly id: string }>> {
    try {
      const config = await resolveConfig(this.context);
      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const id = normalizeWritableMemoryContextId(input.id);

      if (!id.ok) {
        return id;
      }

      const filePath = resolveContextPath(rootDir, id.value);

      if (!(await exists(filePath))) {
        return error("context_not_found", `Expert memory context not found: ${id.value}`, {
          id: id.value,
        });
      }

      await rm(filePath);

      if (id.value === MEMORY_CONTEXT_ID) {
        await regenerateSummary(rootDir, config, this.agentId);
      }

      return ok({ id: id.value });
    } catch (caught) {
      return error("store_error", `Failed to delete expert memory context: ${input.id}`, {
        id: input.id,
        ...toErrorDetails(caught),
      });
    }
  }

  async searchContext(
    input: ExpertAgentStoredContextItemSearchInput,
  ): Promise<ExpertAgentContextResult<readonly ExpertAgentContextItemSearchMatch[]>> {
    try {
      const config = await resolveConfig(this.context);

      if (!config.enabled || !config.useMemories) {
        return ok([]);
      }

      const rootDir = resolveMemoryRoot(this.context.workspaceRoot, config, this.agentId);
      const ids = await collectMemoryContextIds(rootDir);
      const query = input.caseSensitive === true ? input.query : input.query.toLowerCase();
      const maxResults = input.maxResults ?? 20;
      const contextLines = input.contextLines ?? 0;
      const matches: ExpertAgentContextItemSearchMatch[] = [];

      for (const id of ids) {
        const stored = await readStoredContext(rootDir, id);
        const lines = stored.content.split("\n");

        for (const [index, line] of lines.entries()) {
          const searchedLine = input.caseSensitive === true ? line : line.toLowerCase();

          if (!searchedLine.includes(query)) {
            continue;
          }

          matches.push({
            id,
            lineNumber: index + 1,
            line,
            before: readContextLines(lines, index - contextLines, index),
            after: readContextLines(lines, index + 1, index + 1 + contextLines),
          });

          if (matches.length >= maxResults) {
            return ok(matches);
          }
        }
      }

      return ok(matches);
    } catch (caught) {
      return error("store_error", "Failed to search expert memory.", toErrorDetails(caught));
    }
  }
}

async function resolveConfig(context: ExpertAgentPluginSetupContext): Promise<MemoryPluginConfig> {
  const hostConfig = await readHostConfig(context);
  const envConfig = readEnvConfig(context.env);
  const explicitConfig =
    context.config === undefined ? undefined : readConfigObject(context.config);

  return MemoryPluginConfigSchema.parse({
    ...envConfig,
    ...(hostConfig ?? {}),
    ...(explicitConfig ?? {}),
  });
}

function readConfigObject(input: unknown): Record<string, unknown> {
  if (input !== null && typeof input === "object" && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }

  throw new Error(`Expert Memory plugin config must be an object, received ${describeConfigInput(input)}.`);
}

function describeConfigInput(input: unknown): string {
  if (input === null) {
    return "null";
  }

  if (Array.isArray(input)) {
    return "array";
  }

  return typeof input;
}

async function readHostConfig(
  context: ExpertAgentPluginSetupContext,
): Promise<Record<string, unknown> | undefined> {
  const result = await context.contextSystem.read({
    namespace: HOST_CONTEXT_NAMESPACE,
    id: MEMORY_CONFIG_CONTEXT_ID,
  });

  if (!result.ok) {
    return undefined;
  }

  return JSON.parse(result.value.content) as Record<string, unknown>;
}

function readEnvConfig(env: NodeJS.ProcessEnv): Partial<MemoryPluginConfig> {
  return {
    ...readBooleanEnv(env, createPluginEnvName("enabled"), "enabled"),
    ...readBooleanEnv(env, createPluginEnvName("useMemories"), "useMemories"),
    ...readBooleanEnv(env, createPluginEnvName("generateMemories"), "generateMemories"),
    ...readStringEnv(env, createPluginEnvName("memoryRoot"), "memoryRoot"),
  };
}

function createPluginEnvName(name: string): string {
  return createExpertAgentPluginConfigEnvName({
    pluginId: PLUGIN_ID,
    name,
  });
}

function readBooleanEnv<TKey extends keyof MemoryPluginConfig>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: TKey,
): Partial<MemoryPluginConfig> {
  const value = env[name];

  if (value === undefined) {
    return {};
  }

  return {
    [key]: value === "1" || value.toLowerCase() === "true",
  } as Partial<MemoryPluginConfig>;
}

function readStringEnv<TKey extends keyof MemoryPluginConfig>(
  env: NodeJS.ProcessEnv,
  name: string,
  key: TKey,
): Partial<MemoryPluginConfig> {
  const value = env[name];

  return value === undefined ? {} : ({ [key]: value } as Partial<MemoryPluginConfig>);
}

function resolveMemoryRoot(
  workspaceRoot: string,
  config: MemoryPluginConfig,
  agentId: string,
): string {
  const workspacePath = resolve(workspaceRoot);
  const rootPath = resolve(workspacePath, config.memoryRoot, sanitizeIdSegment(agentId));

  assertPathInside(rootPath, workspacePath, `Invalid expert memory root: ${config.memoryRoot}`);

  return rootPath;
}

async function collectMemoryContextIds(rootDir: string): Promise<readonly string[]> {
  const ids = [
    ...(await exists(resolveContextPath(rootDir, SUMMARY_CONTEXT_ID)) ? [SUMMARY_CONTEXT_ID] : []),
    ...(await exists(resolveContextPath(rootDir, MEMORY_CONTEXT_ID)) ? [MEMORY_CONTEXT_ID] : []),
    ...(await collectDirectoryMarkdownIds(rootDir, TASKS_PREFIX)),
    ...(await collectDirectoryMarkdownIds(rootDir, PENDING_PREFIX)),
  ];

  return ids.sort();
}

async function collectDirectoryMarkdownIds(
  rootDir: string,
  prefix: string,
): Promise<readonly string[]> {
  const dir = resolve(rootDir, prefix);

  if (!(await exists(dir))) {
    return [];
  }

  const entries = await readdir(dir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(MARKDOWN_EXTENSION))
    .map((entry) => `${prefix}${entry.name}`);
}

async function readStoredContext(
  rootDir: string,
  id: string,
): Promise<ExpertAgentStoredContextItem> {
  const path = resolveContextPath(rootDir, id);
  const [stats, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
  const parsed = parseMarkdown(raw);
  const metadata = normalizeMetadata(id, parseMetadata(parsed.frontmatter, id));
  const sizeBytes = Buffer.byteLength(parsed.content, "utf8");
  const revision = `${Math.trunc(stats.mtimeMs)}:${stats.size}`;

  return {
    id,
    content: parsed.content,
    metadata,
    revision,
    etag: revision,
    sizeBytes,
  };
}

function createStoredContext(options: {
  readonly id: string;
  readonly content: string;
  readonly metadata?: Partial<ExpertAgentContextItemMetadata> | undefined;
}): ExpertAgentStoredContextItem {
  const metadata = normalizeMetadata(options.id, {
    trigger: defaultTriggerForContextId(options.id),
    trustLevel: "workspace",
    sensitivity: "internal",
    ...options.metadata,
  });

  return {
    id: options.id,
    content: options.content,
    metadata,
    revision: undefined,
    etag: undefined,
    sizeBytes: Buffer.byteLength(options.content, "utf8"),
  };
}

function toSummary(context: ExpertAgentStoredContextItem): ExpertAgentContextItemSummary {
  return {
    id: context.id,
    metadata: context.metadata,
    ...(context.revision === undefined ? {} : { revision: context.revision }),
    ...(context.etag === undefined ? {} : { etag: context.etag }),
    ...(context.sizeBytes === undefined ? {} : { sizeBytes: context.sizeBytes }),
  };
}

async function regenerateSummary(
  rootDir: string,
  config: MemoryPluginConfig,
  agentId: string,
): Promise<void> {
  await mkdir(rootDir, { recursive: true });
  const memoryPath = resolveContextPath(rootDir, MEMORY_CONTEXT_ID);
  const memoryExists = await exists(memoryPath);
  const memory = memoryExists ? await readStoredContext(rootDir, MEMORY_CONTEXT_ID) : undefined;
  const content = renderSummary(
    memory?.metadata.sensitivity === "restricted" ? "" : (memory?.content ?? ""),
    config.summaryMaxBytes,
  );
  const context: ExpertAgentStoredContextItem = {
    id: SUMMARY_CONTEXT_ID,
    content,
    metadata: {
      description: "Compressed ExpertAgent memory summary loaded at session start.",
      trigger: "always_on",
      trustLevel: "workspace",
      sensitivity: "internal",
    },
    sizeBytes: Buffer.byteLength(content, "utf8"),
  };

  await writeFile(
    resolveContextPath(rootDir, SUMMARY_CONTEXT_ID),
    serializeMarkdownWithFrontmatter(context, {
      schemaVersion: "pragma.memory-summary/v1",
      agentId,
      updatedAt: new Date().toISOString(),
      audit: { createdBy: "expert-memory" },
    }),
    "utf8",
  );
}

function renderSummary(memoryContent: string, maxBytes: number): string {
  const disclaimer = [
    "# Expert Memory Summary",
    "",
    "Memory is historical recall, not authoritative policy. Current user instructions, AGENTS.md, and formal context take precedence.",
    "Read expert-memory/memory.md when more detail is needed.",
    "",
  ].join("\n");
  const compacted = memoryContent
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(0, 80)
    .join("\n");

  return trimUtf8(`${disclaimer}${compacted}\n`, maxBytes);
}

function serializeMarkdown(context: ExpertAgentStoredContextItem, agentId: string): string {
  const extra =
    context.id === MEMORY_CONTEXT_ID
      ? MemoryLedgerSchema.parse({
          agentId,
          updatedAt: new Date().toISOString(),
          entryCount: countMemoryEntries(context.content),
          audit: { createdBy: "expert-memory" },
        })
      : MemoryTaskEvidenceSchema.parse({
          agentId,
          runId: readRunId(context.id) ?? "manual",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          audit: { createdBy: "expert-memory" },
        });

  return serializeMarkdownWithFrontmatter(context, extra);
}

function serializeMarkdownWithFrontmatter(
  context: ExpertAgentStoredContextItem,
  extra: Record<string, unknown>,
): string {
  const frontmatter = {
    ...extra,
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
  };

  return `---\n${Object.entries(frontmatter)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("\n")}\n---\n${context.content}`;
}

function parseMarkdown(raw: string): {
  readonly frontmatter: Record<string, unknown>;
  readonly content: string;
} {
  if (!raw.startsWith("---\n")) {
    return { frontmatter: {}, content: raw };
  }

  const end = raw.indexOf("\n---\n", 4);

  if (end === -1) {
    return { frontmatter: {}, content: raw };
  }

  const frontmatter = Object.fromEntries(
    raw
      .slice(4, end)
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        const separator = line.indexOf(":");
        const key = line.slice(0, separator).trim();
        const rawValue = line.slice(separator + 1).trim();

        return [key, parseFrontmatterValue(rawValue)];
      }),
  );

  return {
    frontmatter,
    content: raw.slice(end + "\n---\n".length),
  };
}

function parseFrontmatterValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function parseMetadata(
  frontmatter: Record<string, unknown>,
  id: string,
): ExpertAgentContextItemMetadata {
  return {
    ...(typeof frontmatter["description"] === "string"
      ? { description: frontmatter["description"] }
      : {}),
    trigger:
      frontmatter["trigger"] === "always_on" ||
      frontmatter["trigger"] === "model_decision" ||
      frontmatter["trigger"] === "manual"
        ? frontmatter["trigger"]
        : defaultTriggerForContextId(id),
    ...(isTrustLevel(frontmatter["trustLevel"]) ? { trustLevel: frontmatter["trustLevel"] } : {}),
    ...(isSensitivity(frontmatter["sensitivity"])
      ? { sensitivity: frontmatter["sensitivity"] }
      : {}),
  };
}

function isTrustLevel(value: unknown): value is ExpertAgentContextItemMetadata["trustLevel"] {
  return value === "system" || value === "workspace" || value === "user" || value === "external";
}

function isSensitivity(value: unknown): value is ContextSensitivity {
  return (
    value === "public" ||
    value === "internal" ||
    value === "confidential" ||
    value === "restricted"
  );
}

function defaultTriggerForContextId(id: string): ExpertAgentContextItemMetadata["trigger"] {
  if (id === SUMMARY_CONTEXT_ID) {
    return "always_on";
  }

  if (id === MEMORY_CONTEXT_ID) {
    return "model_decision";
  }

  return "manual";
}

function normalizeMemoryContextId(id: string): ExpertAgentContextResult<string> {
  if (isAllowedMemoryContextId(id)) {
    return ok(id);
  }

  return error("invalid_input", `Invalid expert memory context id: ${id}`, { id });
}

function normalizeWritableMemoryContextId(id: string): ExpertAgentContextResult<string> {
  if (id === SUMMARY_CONTEXT_ID) {
    return error("permission_denied", "summary.md is generated from memory.md and cannot be written directly.");
  }

  return normalizeMemoryContextId(id);
}

function isAllowedMemoryContextId(id: string): boolean {
  return (
    id === SUMMARY_CONTEXT_ID ||
    id === MEMORY_CONTEXT_ID ||
    (id.startsWith(TASKS_PREFIX) && id.endsWith(MARKDOWN_EXTENSION)) ||
    (id.startsWith(PENDING_PREFIX) && id.endsWith(MARKDOWN_EXTENSION))
  );
}

function resolveContextPath(rootDir: string, id: string): string {
  const path = resolve(rootDir, id);

  if (path === rootDir || !isPathInside(path, rootDir)) {
    throw new Error(`Invalid memory context id: ${id}`);
  }

  return path;
}

function assertPathInside(path: string, rootDir: string, message: string): void {
  if (!isPathInside(path, rootDir)) {
    throw new Error(message);
  }
}

function isPathInside(path: string, rootDir: string): boolean {
  const relativePath = relative(rootDir, path);

  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

function validateExpectedRevision(
  existing: ExpertAgentStoredContextItem,
  input: ExpertAgentStoredContextItemUpdateInput,
): ExpertAgentContextResult<never> | undefined {
  if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
    return error("context_conflict", `Expert memory revision conflict: ${input.id}`);
  }

  if (input.expectedEtag !== undefined && input.expectedEtag !== existing.etag) {
    return error("context_conflict", `Expert memory etag conflict: ${input.id}`);
  }

  return undefined;
}

function readContentRange(
  content: string,
  options: { readonly start: number; readonly offset?: number | undefined },
): {
  readonly content: string;
  readonly requestedStartOffset: number;
  readonly startOffset: number;
  readonly endOffset: number;
  readonly nextStartOffset: number;
  readonly truncated: boolean;
} {
  const buffer = Buffer.from(content, "utf8");
  const requestedStartOffset = Math.min(buffer.byteLength, Math.max(0, options.start));
  const end =
    options.offset === undefined
      ? buffer.byteLength
      : Math.min(buffer.byteLength, requestedStartOffset + Math.max(0, options.offset));
  const decoded = buffer.subarray(requestedStartOffset, end).toString("utf8");

  return {
    content: decoded,
    requestedStartOffset,
    startOffset: requestedStartOffset,
    endOffset: end,
    nextStartOffset: end,
    truncated: end < buffer.byteLength,
  };
}

function calculateLineRange(content: string, startOffset: number, endOffset: number): {
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
} {
  const prefix = Buffer.from(content, "utf8").subarray(0, startOffset).toString("utf8");
  const range = Buffer.from(content, "utf8").subarray(startOffset, endOffset).toString("utf8");

  return {
    startLine: countNewlines(prefix) + 1,
    endLine: countNewlines(prefix) + countNewlines(range) + 1,
    totalLines: countNewlines(content) + 1,
  };
}

function countNewlines(content: string): number {
  return content.split("\n").length - 1;
}

function readContextLines(
  lines: readonly string[],
  start: number,
  end: number,
): readonly string[] {
  return lines.slice(Math.max(0, start), Math.min(lines.length, end));
}

async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

function readRunId(id: string): string | undefined {
  if (!id.startsWith(TASKS_PREFIX) && !id.startsWith(PENDING_PREFIX)) {
    return undefined;
  }

  return id.slice(id.indexOf("/") + 1, -MARKDOWN_EXTENSION.length);
}

function renderPendingMemoryCandidate(options: {
  readonly query: string;
  readonly output: string;
  readonly runId: string;
}): string {
  return [
    `# Pending Memory Candidate ${options.runId}`,
    "",
    "## Input Summary",
    "",
    trimCharacters(options.query, 2000),
    "",
    "## Output Summary",
    "",
    trimCharacters(options.output, 4000),
    "",
    "## Candidate Memories",
    "",
    "- Review this run and merge stable preferences, workflows, decisions, pitfalls, or facts into memory.md when appropriate.",
    "",
  ].join("\n");
}

function stringifyOutput(output: unknown): string {
  return typeof output === "string" ? output : JSON.stringify(output, null, 2);
}

function containsSensitiveContent(content: string): boolean {
  return /(api[_-]?key|password|private[_-]?key|secret|token)\s*[:=]/i.test(content);
}

function sanitizeIdSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

function trimCharacters(value: string, maxCharacters: number): string {
  return value.length <= maxCharacters ? value : `${value.slice(0, maxCharacters)}\n[truncated]`;
}

function trimUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");

  if (buffer.byteLength <= maxBytes) {
    return value;
  }

  const suffix = "\n[truncated]\n";
  const contentMaxBytes = Math.max(0, maxBytes - Buffer.byteLength(suffix, "utf8"));
  let output = "";
  let sizeBytes = 0;

  for (const character of value) {
    const characterSizeBytes = Buffer.byteLength(character, "utf8");

    if (sizeBytes + characterSizeBytes > contentMaxBytes) {
      break;
    }

    output += character;
    sizeBytes += characterSizeBytes;
  }

  return `${output}${suffix}`;
}

function countMemoryEntries(content: string): number {
  return content
    .split("\n")
    .filter((line) => line.trim().startsWith("- ") || line.trim().match(/^\d+\./) !== null)
    .length;
}

function toErrorDetails(errorValue: unknown): Record<string, unknown> {
  if (errorValue instanceof Error) {
    return { message: errorValue.message };
  }

  return { message: String(errorValue) };
}
