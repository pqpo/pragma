import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";

import type {
  ExpertAgentContextItemMetadata,
  ExpertAgentContextItemSummary,
  ExpertAgentStoredContextItem,
} from "@pragma/core";
import { normalizeMetadata } from "@pragma/core";

import {
  EXPERIENCE_MEMORY_PREFIX,
  FACT_MEMORY_PREFIX,
  EVIDENCE_PREFIX,
  JSON_EXTENSION,
  MARKDOWN_EXTENSION,
  SKILLS_PREFIX,
  SUMMARY_CONTEXT_ID,
  TASK_MEMORY_PREFIX,
} from "./constants.ts";
import type { SkillMemoryConfig } from "../skill-memory/schema.ts";
import type { MemorySystem } from "../memory-system/index.ts";
import { expandHomePath, resolveUserMemoryHome } from "../storage.ts";
import {
  inferSchemaVersion,
  isAllowedMemoryContextId,
  parseMarkdown,
  parseMetadata,
} from "../skill-memory/utils.ts";
import { sanitizeIdSegment } from "../skill-memory/utils.ts";

export interface MemoryArtifactRoots {
  readonly contextRootDir: string;
  readonly skillRootDir: string;
}

export function resolveMemoryArtifactRoots(
  workspaceRoot: string,
  config: SkillMemoryConfig,
  agentId: string,
): MemoryArtifactRoots {
  return {
    contextRootDir: resolveMemoryContextRoot(workspaceRoot, config, agentId),
    skillRootDir: resolveSkillMemoryRoot(workspaceRoot, config, agentId),
  };
}

export function resolveMemoryContextRoot(
  _workspaceRoot: string,
  config: SkillMemoryConfig,
  agentId: string,
): string {
  return resolveMemoryRootForConfig(config.memoryRoot, agentId);
}

export function resolveSkillMemoryRoot(
  workspaceRoot: string,
  config: SkillMemoryConfig,
  agentId: string,
): string {
  return resolve(resolveMemoryContextRoot(workspaceRoot, config, agentId), "skill-memory");
}

export function resolveRootForMemoryContextId(roots: MemoryArtifactRoots, id: string): string {
  if (id.startsWith(SKILLS_PREFIX)) {
    return roots.skillRootDir;
  }

  return roots.contextRootDir;
}

export async function collectMemoryContextIds(
  roots: MemoryArtifactRoots,
): Promise<readonly string[]> {
  const markdownIds = await collectRecursiveIds(roots.contextRootDir, "", [MARKDOWN_EXTENSION]);
  const jsonIds = await collectRecursiveIds(roots.contextRootDir, EVIDENCE_PREFIX, [
    JSON_EXTENSION,
  ]);
  const skillIds = await collectRecursiveIds(roots.skillRootDir, SKILLS_PREFIX, [
    MARKDOWN_EXTENSION,
  ]);

  return [...new Set([...markdownIds, ...jsonIds, ...skillIds])].sort();
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
  const metadata = normalizeMetadata(id, parseMetadata(parsed.frontmatter));
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
    trigger: "manual",
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
  roots: MemoryArtifactRoots,
  memorySystem: MemorySystem,
  agentId: string,
): Promise<void> {
  await mkdir(roots.contextRootDir, { recursive: true });
  const artifacts = await memorySystem.buildContextArtifacts({ agentId });

  if (!artifacts.ok) {
    throw new Error(artifacts.error.message);
  }

  const summary = await memorySystem.buildAlwaysOnSummary({ agentId });

  if (!summary.ok) {
    throw new Error(summary.error.message);
  }

  await writeStoredMarkdown(
    roots.contextRootDir,
    createStoredContext({
      id: SUMMARY_CONTEXT_ID,
      content: summary.value,
      metadata: {
        description: "Always-on summary assembled from task, fact, skill, and experience memory.",
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
    },
  );

  await syncGeneratedContextPrefix(
    roots.contextRootDir,
    TASK_MEMORY_PREFIX,
    artifacts.value.filter((item) => item.id.startsWith(TASK_MEMORY_PREFIX)),
    agentId,
  );
  await syncGeneratedContextPrefix(
    roots.contextRootDir,
    EXPERIENCE_MEMORY_PREFIX,
    artifacts.value.filter((item) => item.id.startsWith(EXPERIENCE_MEMORY_PREFIX)),
    agentId,
  );
  await syncGeneratedContextPrefix(
    roots.contextRootDir,
    FACT_MEMORY_PREFIX,
    artifacts.value.filter((item) => item.id.startsWith(FACT_MEMORY_PREFIX)),
    agentId,
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
    priority: context.metadata.priority,
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

function resolveMemoryRootForConfig(configuredRoot: string, agentId: string): string {
  const expandedRoot = expandHomePath(configuredRoot);
  const basePath = isAbsolute(expandedRoot)
    ? resolve(expandedRoot)
    : resolve(resolveUserMemoryHome(), expandedRoot);

  return resolve(basePath, sanitizeIdSegment(agentId));
}

export function isPathInside(path: string, rootDir: string): boolean {
  const relativePath = relative(rootDir, path);

  return relativePath !== "" && !relativePath.startsWith("..") && !isAbsolute(relativePath);
}

export async function exists(path: string): Promise<boolean> {
  return (await stat(path).catch(() => undefined)) !== undefined;
}

async function syncGeneratedContextPrefix(
  rootDir: string,
  prefix: string,
  items: readonly {
    readonly id: string;
    readonly content: string;
    readonly description: string;
    readonly trigger: "always_on" | "model_decision" | "manual";
  }[],
  agentId: string,
): Promise<void> {
  const existingIds = new Set(await collectRecursiveIds(rootDir, prefix, [MARKDOWN_EXTENSION]));
  const nextIds = new Set(items.map((item) => item.id));

  for (const item of items) {
    await writeStoredMarkdown(
      rootDir,
      createStoredContext({
        id: item.id,
        content: item.content,
        metadata: {
          description: item.description,
          trigger: item.trigger,
          trustLevel: "workspace",
          sensitivity: "internal",
        },
      }),
      {
        schemaVersion: inferSchemaVersion(item.id),
        agentId,
        updatedAt: new Date().toISOString(),
        audit: { createdBy: "memory-system" },
      },
    );
  }

  for (const existingId of existingIds) {
    if (nextIds.has(existingId)) {
      continue;
    }

    await rm(resolveContextPath(rootDir, existingId), {
      force: true,
    });
  }
}
