import type { Expert } from "@pragma/core";
import { constants } from "node:fs";
import { access, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

const NON_ALPHANUMERIC = /[^a-z0-9]+/g;

export interface QoderSkillPlugin {
  readonly path: string;
  readonly skills: readonly string[];
}

export async function materializeQoderSkillPlugin(
  agent: Expert,
  sessionDir: string,
): Promise<QoderSkillPlugin> {
  const pluginDir = join(sessionDir, "plugin");
  const skillsDir = join(pluginDir, "skills");
  const pluginName = `pragma-${sanitize(agent.id)}`;

  await rm(pluginDir, { recursive: true, force: true });
  await mkdir(skillsDir, { recursive: true });
  await mkdir(join(pluginDir, ".qoder-plugin"), { recursive: true });
  await writeFile(
    join(pluginDir, ".qoder-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: pluginName,
        version: "0.0.0",
        description: `Pragma Expert skills for ${agent.name}.`,
      },
      null,
      2,
    )}\n`,
  );

  const qualifiedSkills: string[] = [];
  const usedSlugs = new Set<string>();
  for (const skill of agent.skills?.skills ?? []) {
    if (skill.path === undefined) continue;
    const sourcePath = isAbsolute(skill.path)
      ? skill.path
      : resolve(skill.baseDir ?? agent.workspace, skill.path);
    const info = await stat(sourcePath);
    const sourceDir = info.isDirectory() ? sourcePath : dirname(sourcePath);
    const sourceFile = info.isDirectory() ? join(sourcePath, "SKILL.md") : sourcePath;
    await access(sourceFile, constants.R_OK);

    const slug = allocateSlug(usedSlugs, sanitize(skill.name));
    const targetDir = join(skillsDir, slug);
    await cp(sourceDir, targetDir, {
      recursive: true,
      dereference: true,
      filter: (path) => basename(path) !== "node_modules",
    });
    await writeFile(
      join(targetDir, "SKILL.md"),
      ensureFrontmatter(await readFile(sourceFile, "utf8"), slug, skill.description),
    );
    qualifiedSkills.push(`${pluginName}:${slug}`);
  }

  return { path: pluginDir, skills: qualifiedSkills };
}

function sanitize(value: string): string {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(NON_ALPHANUMERIC, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

function allocateSlug(used: Set<string>, base: string): string {
  let result = base;
  let suffix = 2;
  while (used.has(result)) result = `${base}-${suffix++}`;
  used.add(result);
  return result;
}

function ensureFrontmatter(content: string, name: string, description: string): string {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${normalized}`;
  }

  const end = normalized.indexOf("\n---\n", 4);
  if (end < 0) {
    return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n${normalized}`;
  }

  const lines = normalized.slice(4, end).split("\n");
  if (!lines.some((line) => line.trimStart().startsWith("name:"))) {
    lines.unshift(`name: ${JSON.stringify(name)}`);
  }
  if (!lines.some((line) => line.trimStart().startsWith("description:"))) {
    lines.push(`description: ${JSON.stringify(description)}`);
  }
  return `---\n${lines.join("\n")}\n---\n${normalized.slice(end + 5)}`;
}
