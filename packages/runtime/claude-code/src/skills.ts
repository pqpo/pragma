import type { Expert } from "@pragma/core";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface MaterializeClaudeCodePluginOptions {
  readonly agent: Expert;
  readonly sessionDir: string;
  readonly compactionHook?: {
    readonly url: string;
    readonly authorization: string;
  };
}

const FRONTMATTER_DELIMITER = "---";
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;

export async function materializeClaudeCodePlugin({
  agent,
  sessionDir,
  compactionHook,
}: MaterializeClaudeCodePluginOptions): Promise<string> {
  const pluginDir = join(sessionDir, "plugin");
  const skillsDir = join(pluginDir, "skills");

  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(skillsDir, { recursive: true });
  await writePluginManifest(pluginDir, agent);
  if (compactionHook !== undefined) {
    await writeCompactionHooks(pluginDir, compactionHook);
  }

  const usedSlugs = new Set<string>();
  for (const skill of agent.skills?.skills ?? []) {
    if (skill.path === undefined) {
      continue;
    }

    const source = await resolveSkillSource({
      path: skill.path,
      baseDir: skill.baseDir,
      workspace: agent.workspace,
    });
    const slug = allocateSkillSlug(usedSlugs, sanitizeSkillName(skill.name));
    const targetDir = join(skillsDir, slug);

    await cp(source.dir, targetDir, {
      recursive: true,
      dereference: true,
      filter: (sourcePath) => basename(sourcePath) !== "node_modules",
    });
    await writeFile(
      join(targetDir, "SKILL.md"),
      ensureSkillFrontmatter(await readFile(source.skillFile, "utf8"), {
        name: slug,
        description: skill.description,
      }),
    );
  }

  return pluginDir;
}

async function writeCompactionHooks(
  pluginDir: string,
  hook: { readonly url: string; readonly authorization: string },
): Promise<void> {
  const hooksDir = join(pluginDir, "hooks");
  await mkdir(hooksDir, { recursive: true });
  const handler = {
    type: "http",
    url: hook.url,
    headers: { Authorization: hook.authorization },
    timeout: 10,
  };
  await writeFile(
    join(hooksDir, "hooks.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreCompact: [{ matcher: "auto|manual", hooks: [handler] }],
          PostCompact: [{ matcher: "auto|manual", hooks: [handler] }],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

async function writePluginManifest(pluginDir: string, agent: Expert): Promise<void> {
  const manifestDir = join(pluginDir, ".claude-plugin");
  await mkdir(manifestDir, { recursive: true });
  await writeFile(
    join(manifestDir, "plugin.json"),
    `${JSON.stringify(
      {
        name: `pragma-${sanitizeSkillName(agent.id)}`,
        version: "0.0.0",
        description: `Pragma Expert skills for ${agent.name}.`,
      },
      null,
      2,
    )}\n`,
  );
}

async function resolveSkillSource({
  path,
  baseDir,
  workspace,
}: {
  readonly path: string;
  readonly baseDir?: string | undefined;
  readonly workspace: string;
}): Promise<{ readonly dir: string; readonly skillFile: string }> {
  const resolvedPath = isAbsolute(path) ? path : resolve(baseDir ?? workspace, path);
  const info = await stat(resolvedPath);
  const dir = info.isDirectory() ? resolvedPath : dirname(resolvedPath);
  const skillFile = info.isDirectory() ? join(resolvedPath, "SKILL.md") : resolvedPath;

  await access(skillFile, constants.R_OK);

  return { dir, skillFile };
}

function sanitizeSkillName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, "-")
    .replace(/^-+|-+$/g, "");

  return slug === "" ? "skill" : slug;
}

function allocateSkillSlug(usedSlugs: Set<string>, baseSlug: string): string {
  let slug = baseSlug;
  let index = 2;

  while (usedSlugs.has(slug)) {
    slug = `${baseSlug}-${index++}`;
  }

  usedSlugs.add(slug);
  return slug;
}

function ensureSkillFrontmatter(
  content: string,
  fallback: { readonly name: string; readonly description: string },
): string {
  const parsed = parseFrontmatter(content);

  if (parsed === undefined) {
    return prependFrontmatter(content, fallback.name, fallback.description);
  }

  const lines = [...parsed.lines];

  if (!frontmatterHasKey(lines, "name")) {
    lines.unshift(`name: ${quoteYamlString(fallback.name)}`);
  }

  if (!frontmatterHasKey(lines, "description")) {
    const nameIndex = findFrontmatterKeyIndex(lines, "name");
    lines.splice(
      nameIndex < 0 ? 0 : nameIndex + 1,
      0,
      `description: ${quoteYamlString(fallback.description)}`,
    );
  }

  return [
    FRONTMATTER_DELIMITER,
    ...lines,
    FRONTMATTER_DELIMITER,
    trimLeadingNewline(parsed.body),
  ].join("\n");
}

function prependFrontmatter(content: string, name: string, description: string): string {
  return [
    FRONTMATTER_DELIMITER,
    `name: ${quoteYamlString(name)}`,
    `description: ${quoteYamlString(description)}`,
    FRONTMATTER_DELIMITER,
    trimLeadingNewline(content),
  ].join("\n");
}

function parseFrontmatter(
  content: string,
): { readonly lines: readonly string[]; readonly body: string } | undefined {
  const normalized = content.replace(/\r\n/g, "\n");

  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) {
    return undefined;
  }

  const endIndex = normalized.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, 4);

  if (endIndex < 0) {
    return undefined;
  }

  return {
    lines: normalized.slice(4, endIndex).split("\n"),
    body: normalized.slice(endIndex + 5),
  };
}

function frontmatterHasKey(lines: readonly string[], key: string): boolean {
  return findFrontmatterKeyIndex(lines, key) >= 0;
}

function findFrontmatterKeyIndex(lines: readonly string[], key: string): number {
  return lines.findIndex((line) => readFrontmatterKey(line) === key);
}

function readFrontmatterKey(line: string): string | undefined {
  const trimmed = line.trimStart();
  const colonIndex = trimmed.indexOf(":");

  if (colonIndex < 0) {
    return undefined;
  }

  return trimmed.slice(0, colonIndex).trim();
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function trimLeadingNewline(value: string): string {
  return value.startsWith("\n") ? value.slice(1) : value;
}
