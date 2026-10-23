import type { Expert } from "@pragma/core";
import { cp, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { isMap, parseDocument } from "yaml";

/** Only the current Expert's packages enter OpenCode's private discovery root. */
export async function materializeOpenCodeSkills(
  agent: Expert,
  sessionDir: string,
): Promise<string> {
  const root = join(sessionDir, "config", "opencode", "skills");
  await mkdir(dirname(root), { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(join(dirname(root), ".skills-"));
  try {
    const names = new Set<string>();
    for (const skill of agent.skills?.skills ?? []) {
      if (skill.path === undefined) continue;
      const source = isAbsolute(skill.path)
        ? skill.path
        : resolve(skill.baseDir ?? agent.workspace, skill.path);
      const directory = (await stat(source)).isDirectory() ? source : dirname(source);
      const entry = directory === source ? join(source, "SKILL.md") : source;
      const content = (await readFile(entry, "utf8")).replace(/\r\n/g, "\n");
      const match = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(content);
      const document = parseDocument(match?.[1] ?? "{}");
      if (document.errors.length > 0 || !isMap(document.contents)) {
        throw new Error(`Invalid OpenCode skill frontmatter: ${skill.name}`);
      }
      const declaredName = document.get("name");
      const base =
        String(typeof declaredName === "string" ? declaredName : skill.name)
          .trim()
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-+|-+$/g, "")
          .slice(0, 60)
          .replace(/-+$/g, "") || "skill";
      let name = base;
      let suffix = 2;
      while (names.has(name)) name = `${base}-${suffix++}`;
      names.add(name);
      document.set("name", name);
      if (typeof document.get("description") !== "string" || document.get("description") === "") {
        document.set("description", skill.description);
      }
      const target = join(staging, name);
      await cp(directory, target, {
        recursive: true,
        dereference: true,
        filter: (path) =>
          !["node_modules", ".git", ".env", ".DS_Store"].includes(basename(path)) &&
          (!basename(path).startsWith(".env.") || basename(path) === ".env.example"),
      });
      await writeFile(
        join(target, "SKILL.md"),
        `---\n${document.toString()}---\n${content.slice(match?.[0].length ?? 0)}`,
      );
    }
    // Projection is rebuildable, but invalid input or a failed copy must not erase
    // the last usable package set before a retry can prepare its replacement.
    await rm(root, { recursive: true, force: true });
    await rename(staging, root);
    return root;
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}
