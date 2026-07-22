import type { Expert } from "@pragma/core";
import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  cp,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

export interface MaterializeCodexSkillsOptions {
  readonly agent: Expert;
  readonly codexHome: string;
  readonly sharedSkillsRoot?: string | undefined;
}

const FRONTMATTER_DELIMITER = "---";
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;

export async function materializeCodexSkills({
  agent,
  codexHome,
  sharedSkillsRoot,
}: MaterializeCodexSkillsOptions): Promise<void> {
  const skillsDir = join(codexHome, "skills");

  await rm(skillsDir, { recursive: true, force: true });
  await mkdir(skillsDir, { recursive: true });

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
    const slug = await allocateSkillSlug(skillsDir, usedSlugs, sanitizeSkillName(skill.name));
    const targetDir = join(skillsDir, slug);
    if (sharedSkillsRoot === undefined) {
      await copySkill(source, targetDir, slug, skill.description);
      continue;
    }
    const fingerprint = await fingerprintSkill(source, slug, skill.description);
    const sharedTarget = join(sharedSkillsRoot, fingerprint.slice(0, 2), fingerprint);
    if ((await stat(sharedTarget).catch(() => undefined))?.isDirectory() !== true) {
      const staging = `${sharedTarget}.${randomUUID()}.tmp`;
      await mkdir(dirname(sharedTarget), { recursive: true, mode: 0o700 });
      await copySkill(source, staging, slug, skill.description);
      try {
        await rename(staging, sharedTarget);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
    await symlink(sharedTarget, targetDir, process.platform === "win32" ? "junction" : "dir");
  }
}

async function copySkill(
  source: { readonly dir: string; readonly skillFile: string },
  targetDir: string,
  slug: string,
  description: string,
): Promise<void> {
  await cp(source.dir, targetDir, {
    recursive: true,
    dereference: true,
    filter: (sourcePath) => basename(sourcePath) !== "node_modules",
  });
  await writeFile(
    join(targetDir, "SKILL.md"),
    ensureSkillFrontmatter(await readFile(source.skillFile, "utf8"), { name: slug, description }),
  );
}

async function fingerprintSkill(
  source: { readonly dir: string; readonly skillFile: string },
  slug: string,
  description: string,
): Promise<string> {
  const hash = createHash("sha256").update(`pragma.codex-skill/v1\0${slug}\0${description}\0`);
  const visit = async (directory: string): Promise<void> => {
    for (const entry of (
      await import("node:fs/promises").then(({ readdir }) =>
        readdir(directory, { withFileTypes: true }),
      )
    ).toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) {
        const relativePath = path.slice(source.dir.length + 1);
        const bytes = await readFile(path);
        hash.update(`${relativePath.length}:${relativePath}:${bytes.byteLength}:`).update(bytes);
      }
    }
  };
  await visit(source.dir);
  return hash.digest("hex");
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

async function allocateSkillSlug(
  skillsDir: string,
  usedSlugs: Set<string>,
  baseSlug: string,
): Promise<string> {
  let slug = baseSlug;
  let index = 2;

  while (usedSlugs.has(slug) || (await pathExists(join(skillsDir, slug)))) {
    slug = `${baseSlug}-${index++}`;
  }

  usedSlugs.add(slug);
  return slug;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
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
