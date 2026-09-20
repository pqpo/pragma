import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  prepareSkillRevisionWorkspace,
  resolveSkillRevisionDraftRootForRemoval,
} from "./skill-revision-workspace.ts";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Skill revision Workspace", () => {
  it("adds the hidden Pragma directory to the repository-local exclude exactly once", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-skill-workspace-"));
    roots.push(root);
    await execFileAsync("git", ["init", root]);

    await prepareSkillRevisionWorkspace(root, "10000000-0000-4000-8000-000000000001");
    await prepareSkillRevisionWorkspace(root, "10000000-0000-4000-8000-000000000002");

    const { stdout } = await execFileAsync("git", [
      "-C",
      root,
      "rev-parse",
      "--git-path",
      "info/exclude",
    ]);
    const excludePath = stdout.trim();
    const exclude = await readFile(
      isAbsolute(excludePath) ? excludePath : resolve(root, excludePath),
      "utf8",
    );
    expect(exclude.split(/\r?\n/u).filter((line) => line === "/.pragma/")).toHaveLength(1);
  });

  it.skipIf(process.platform === "win32")(
    "rejects removal through a linked managed directory",
    async () => {
      const root = await mkdtemp(join(tmpdir(), "pragma-skill-workspace-"));
      roots.push(root);
      const workspace = join(root, "workspace");
      const external = join(root, "external");
      const draftId = "10000000-0000-4000-8000-000000000001";
      const sentinel = join(external, "skill-revision-drafts", draftId, "sentinel.txt");
      await mkdir(workspace, { recursive: true });
    await mkdir(join(external, "skill-revision-drafts", draftId), { recursive: true });
    await writeFile(sentinel, "keep\n");
    await symlink(external, join(workspace, ".pragma"));
    const canonicalWorkspace = await realpath(workspace);

    await expect(
      resolveSkillRevisionDraftRootForRemoval(canonicalWorkspace, draftId),
      ).rejects.toMatchObject({ code: "skill_revision_workspace_escape" });
      await expect(readFile(sentinel, "utf8")).resolves.toBe("keep\n");
    },
  );
});
