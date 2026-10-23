import { defineExpert } from "@pragma/core";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { materializeOpenCodeSkills } from "../src/skills.ts";

describe("OpenCode skill projection", () => {
  it("accepts a custom entry file without frontmatter and rejects malformed metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-opencode-entry-"));
    try {
      const entry = join(root, "instructions.md");
      await writeFile(entry, "Load this body.");
      const agent = await defineExpert({
        id: "entry",
        name: "Entry",
        description: "test",
        scope: "test",
        tags: [],
        workspace: root,
        skills: {
          skills: [
            { type: "local", name: "Entry Skill", description: "Entry description", path: entry },
          ],
        },
      });
      // The projection must not be nested in its own source package.
      const session = await mkdtemp(join(tmpdir(), "pragma-opencode-entry-session-"));
      try {
        const target = await materializeOpenCodeSkills(agent, session);
        const content = await readFile(join(target, "entry-skill", "SKILL.md"), "utf8");
        expect(parse(content.split("---")[1]!)).toEqual({
          name: "entry-skill",
          description: "Entry description",
        });
        expect(content).toContain("Load this body.");
        await writeFile(entry, "---\nname: [invalid\n---\nBody");
        await expect(materializeOpenCodeSkills(agent, session)).rejects.toThrow(
          "Invalid OpenCode skill frontmatter",
        );
        // Failed preparation must preserve the previous usable projection for retry.
        expect(await readFile(join(target, "entry-skill", "SKILL.md"), "utf8")).toBe(content);
        expect(await readdir(join(session, "config", "opencode"))).toEqual(["skills"]);
        await writeFile(entry, "Updated skill body.");
        await materializeOpenCodeSkills(agent, session);
        expect(await readFile(join(target, "entry-skill", "SKILL.md"), "utf8")).toContain(
          "Updated skill body.",
        );
      } finally {
        await rm(session, { recursive: true, force: true });
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("copies packages, normalizes conflicting names, preserves metadata and modes, and removes stale bindings", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-opencode-skills-"));
    try {
      const source = join(root, "source");
      await mkdir(join(source, "references"), { recursive: true });
      await mkdir(join(source, "node_modules"));
      await writeFile(
        join(source, "SKILL.md"),
        "---\nname: Manage Pragma\nmetadata:\n  audience: maintainers\n---\nRead references/skills.md.",
      );
      await writeFile(join(source, "references", "skills.md"), "Run pragma manage skill list.");
      await writeFile(join(source, "probe.sh"), "#!/bin/sh\necho ok\n");
      await chmod(join(source, "probe.sh"), 0o755);
      await writeFile(join(source, ".env"), "PRIVATE");
      await writeFile(join(source, ".env.example"), "PUBLIC_EXAMPLE");
      const skill = {
        type: "local" as const,
        name: "Manage Pragma",
        description: "Manage resources",
        path: "source",
        baseDir: root,
      };
      const agent = await defineExpert({
        id: "test",
        name: "Test",
        description: "test",
        scope: "test",
        tags: [],
        workspace: root,
        skills: { skills: [skill, { ...skill, name: "Manage-Pragma" }] },
      });
      const sessionDir = join(root, "session");
      const target = await materializeOpenCodeSkills(agent, sessionDir);
      expect(await readdir(target)).toEqual(["manage-pragma", "manage-pragma-2"]);
      const content = await readFile(join(target, "manage-pragma-2", "SKILL.md"), "utf8");
      expect(parse(content.split("---")[1]!)).toEqual({
        name: "manage-pragma-2",
        description: "Manage resources",
        metadata: { audience: "maintainers" },
      });
      expect(content).toContain("Read references/skills.md.");
      expect(
        await readFile(join(target, "manage-pragma", "references", "skills.md"), "utf8"),
      ).toContain("pragma manage");
      expect(await readdir(join(target, "manage-pragma"))).not.toContain("node_modules");
      expect(await readdir(join(target, "manage-pragma"))).not.toContain(".env");
      expect(await readFile(join(target, "manage-pragma", ".env.example"), "utf8")).toBe(
        "PUBLIC_EXAMPLE",
      );
      if (process.platform !== "win32")
        expect((await stat(join(target, "manage-pragma", "probe.sh"))).mode & 0o111).toBe(0o111);
      await materializeOpenCodeSkills(agent, sessionDir);
      expect(await readdir(target)).toHaveLength(2);
      const unreadable = await defineExpert({
        id: "missing-source",
        name: "Missing source",
        description: "test",
        scope: "test",
        tags: [],
        workspace: root,
        skills: { skills: [skill, { ...skill, name: "Missing", path: "missing-source" }] },
      });
      await expect(materializeOpenCodeSkills(unreadable, sessionDir)).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readdir(target)).toEqual(["manage-pragma", "manage-pragma-2"]);
      expect(await readFile(join(target, "manage-pragma-2", "SKILL.md"), "utf8")).toBe(content);
      expect(await readdir(join(sessionDir, "config", "opencode"))).toEqual(["skills"]);
      const empty = await defineExpert({
        id: "empty",
        name: "Empty",
        description: "test",
        scope: "test",
        tags: [],
        workspace: root,
      });
      await materializeOpenCodeSkills(empty, sessionDir);
      expect(await readdir(target)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
