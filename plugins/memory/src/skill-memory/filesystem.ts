import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  ExpertAgentContextItemMetadata,
  ExpertAgentContextItemSummary,
  ExpertAgentStoredContextItem,
  ExpertAgentPluginSetupContext,
} from "@pragma/core";
import { normalizeMetadata } from "@pragma/core";

import {
  EVIDENCE_PREFIX,
  JSON_EXTENSION,
  MARKDOWN_EXTENSION,
  SKILLS_PREFIX,
  SUMMARY_CONTEXT_ID,
} from "./constants.ts";
import { resolveConfig } from "./config.ts";
import type { SkillMemoryConfig } from "./schema.ts";
import { renderSummaryIndex } from "./rendering.ts";
import { expandHomePath, resolveUserMemoryHome } from "../storage.ts";
import {
  defaultTriggerForContextId,
  isAllowedMemoryContextId,
  parseMarkdown,
  parseMetadata,
} from "./utils.ts";
import { sanitizeIdSegment } from "./utils.ts";

export function resolveMemoryRoot(
  _workspaceRoot: string,
  config: SkillMemoryConfig,
  agentId: string,
): string {
  const basePath = isAbsolute(expandHomePath(config.memoryRoot))
    ? resolve(expandHomePath(config.memoryRoot))
    : resolve(resolveUserMemoryHome(), config.memoryRoot);
  const rootPath = resolve(basePath, sanitizeIdSegment(agentId));

  return rootPath;
}

export async function collectMemoryContextIds(rootDir: string): Promise<readonly string[]> {
  const markdownIds = await collectRecursiveIds(rootDir, "", [MARKDOWN_EXTENSION]);
  const jsonIds = await collectRecursiveIds(rootDir, EVIDENCE_PREFIX, [JSON_EXTENSION]);

  return [...new Set([...markdownIds, ...jsonIds])].sort();
}

export async function collectRecursiveIds(
  rootDir: string,
  prefix: string,
  extensions: readonly string[],
): Promise<readonly string[]> {
  const dir = resolve(rootDir, prefix);

  if (!(await exists(dir))) {
    return [];
  }

  const results: string[] = [];

  await walk(dir, async (filePath) => {
    if (!extensions.some((extension) => filePath.endsWith(extension))) {
      return;
    }

    const id = relative(rootDir, filePath).replaceAll("\\", "/");
    if (isAllowedMemoryContextId(id)) {
      results.push(id);
    }
  });

  return results;
}

export async function walk(
  dir: string,
  visitor: (filePath: string) => Promise<void>,
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const entryPath = resolve(dir, entry.name);

    if (entry.isDirectory()) {
      await walk(entryPath, visitor);
      continue;
    }

    if (entry.isFile()) {
      await visitor(entryPath);
    }
  }
}

export async function readStoredContext(
  rootDir: string,
  id: string,
): Promise<ExpertAgentStoredContextItem> {
  const path = resolveContextPath(rootDir, id);
  const [stats, raw] = await Promise.all([stat(path), readFile(path, "utf8")]);
  const parsed = path.endsWith(JSON_EXTENSION)
    ? { frontmatter: {}, content: raw }
    : parseMarkdown(raw);
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

export function createStoredContext(options: {
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

export function toSummary(context: ExpertAgentStoredContextItem): ExpertAgentContextItemSummary {
  return {
    id: context.id,
    metadata: context.metadata,
    ...(context.revision === undefined ? {} : { revision: context.revision }),
    ...(context.etag === undefined ? {} : { etag: context.etag }),
    ...(context.sizeBytes === undefined ? {} : { sizeBytes: context.sizeBytes }),
  };
}

export async function regenerateSummary(
  rootDir: string,
  context: ExpertAgentPluginSetupContext,
  agentId: string,
): Promise<void> {
  const config = await resolveConfig(context);
  await mkdir(rootDir, { recursive: true });
  const skillIds = await collectRecursiveIds(rootDir, SKILLS_PREFIX, [MARKDOWN_EXTENSION]);
  const skills = (await Promise.all(
    skillIds.map(async (id) => await readStoredContext(rootDir, id)),
  )).filter((skill) => skill.metadata.sensitivity !== "restricted");
  const content = renderSummaryIndex(skills, config.summaryMaxBytes);
  await writeStoredMarkdown(
    rootDir,
    createStoredContext({
      id: SUMMARY_CONTEXT_ID,
      content,
      metadata: {
        description: "Always-on index of long-term memory skills.",
        trigger: "always_on",
        trustLevel: "workspace",
        sensitivity: "internal",
      },
    }),
    {
      schemaVersion: "pragma.memory-summary/v2",
      agentId,
      updatedAt: new Date().toISOString(),
      audit: { createdBy: "skill-memory" },
      model: "summaryModel",
    },
  );
}

export async function writeStoredMarkdown(
  rootDir: string,
  context: ExpertAgentStoredContextItem,
  extra: Record<string, unknown>,
): Promise<void> {
  const filePath = resolveContextPath(rootDir, context.id);
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, serializeMarkdownWithFrontmatter(context, extra), "utf8");
}

export async function writeJson(path: string, value: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function serializeMarkdownWithFrontmatter(
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

export function resolveContextPath(rootDir: string, id: string): string {
  const path = resolve(rootDir, id);

  if (path === rootDir || !isPathInside(path, rootDir)) {
    throw new Error(`Invalid memory context id: ${id}`);
  }

  return path;
}

export function assertPathInside(path: string, rootDir: string, message: string): void {
  if (!isPathInside(path, rootDir)) {
    throw new Error(message);
  }
}

export function isPathInside(path: string, rootDir: string): boolean {
  const relativePath = relative(rootDir, path);

  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}
