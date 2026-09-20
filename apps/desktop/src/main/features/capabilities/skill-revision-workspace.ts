import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

import { withFileLock } from "@pragma/core";

const execFileAsync = promisify(execFile);

export interface SkillRevisionWorkspacePaths {
  readonly workspacePath: string;
  readonly draftRoot: string;
  readonly worktreePath: string;
}

export function skillRevisionWorkspacePaths(
  workspacePath: string,
  draftId: string,
): SkillRevisionWorkspacePaths {
  if (!isAbsolute(workspacePath)) throw coded("skill_revision_workspace_invalid");
  const draftRoot = join(workspacePath, ".pragma", "skill-revision-drafts", draftId);
  return { workspacePath, draftRoot, worktreePath: join(draftRoot, "worktree") };
}

export async function resolveSkillRevisionDraftRootForRemoval(
  requestedWorkspacePath: string,
  draftId: string,
): Promise<string> {
  const requestedPaths = skillRevisionWorkspacePaths(requestedWorkspacePath, draftId);
  try {
    await lstat(requestedPaths.draftRoot);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return requestedPaths.draftRoot;
    throw error;
  }
  const workspacePath = await resolveSkillRevisionWorkspacePath(requestedWorkspacePath);
  if (workspacePath !== requestedWorkspacePath) throw coded("skill_revision_workspace_invalid");
  const paths = skillRevisionWorkspacePaths(workspacePath, draftId);
  await assertManagedPathComponentsAreNotLinks(workspacePath, [
    ".pragma",
    "skill-revision-drafts",
    draftId,
  ]);
  try {
    const canonicalDraftRoot = await realpath(paths.draftRoot);
    if (canonicalDraftRoot !== paths.draftRoot || !isWithin(workspacePath, canonicalDraftRoot)) {
      throw coded("skill_revision_workspace_escape");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return paths.draftRoot;
}

export async function prepareSkillRevisionWorkspace(
  requestedWorkspacePath: string,
  draftId: string,
  warn?: (message: string, error: unknown) => void,
): Promise<SkillRevisionWorkspacePaths> {
  const workspacePath = await resolveSkillRevisionWorkspacePath(requestedWorkspacePath);
  const paths = skillRevisionWorkspacePaths(workspacePath, draftId);
  await assertManagedPathComponentsAreNotLinks(workspacePath, [
    ".pragma",
    "skill-revision-drafts",
    draftId,
  ]);
  await mkdir(paths.worktreePath, { recursive: true, mode: 0o700 });
  const canonicalDraftRoot = await realpath(paths.draftRoot);
  if (!isWithin(workspacePath, canonicalDraftRoot)) {
    throw coded("skill_revision_workspace_escape");
  }
  await ensureLocalGitExclude(workspacePath).catch((error) => {
    warn?.("The Workspace .pragma directory could not be added to the local Git exclude.", error);
  });
  return paths;
}

export async function resolveSkillRevisionWorkspacePath(
  requestedWorkspacePath: string,
): Promise<string> {
  if (!isAbsolute(requestedWorkspacePath)) throw coded("skill_revision_workspace_invalid");
  return await realpath(requestedWorkspacePath).catch(() => {
    throw coded("skill_revision_workspace_unavailable");
  });
}

async function assertManagedPathComponentsAreNotLinks(
  root: string,
  components: readonly string[],
): Promise<void> {
  let current = root;
  for (const component of components) {
    current = join(current, component);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw coded("skill_revision_workspace_escape");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

async function ensureLocalGitExclude(workspacePath: string): Promise<void> {
  const [{ stdout: rootOutput }, { stdout: excludeOutput }] = await Promise.all([
    execFileAsync("git", ["-C", workspacePath, "rev-parse", "--show-toplevel"]),
    execFileAsync("git", ["-C", workspacePath, "rev-parse", "--git-path", "info/exclude"]),
  ]);
  const repositoryRoot = resolve(rootOutput.trim());
  const rawExcludePath = excludeOutput.trim();
  const excludePath = isAbsolute(rawExcludePath)
    ? rawExcludePath
    : resolve(workspacePath, rawExcludePath);
  const pragmaPath = join(workspacePath, ".pragma");
  if (!isWithin(repositoryRoot, pragmaPath)) return;
  const logical = relative(repositoryRoot, pragmaPath).split(sep).join("/");
  const pattern = `/${logical}/`;
  await withFileLock(`${excludePath}.pragma.lock`, async () => {
    let current = "";
    try {
      current = await readFile(excludePath, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current.split(/\r?\n/u).includes(pattern)) return;
    const next = `${current}${current.length === 0 || current.endsWith("\n") ? "" : "\n"}${pattern}\n`;
    await mkdir(dirname(excludePath), { recursive: true, mode: 0o700 });
    const temporary = `${excludePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, next, { mode: 0o600 });
      await rename(temporary, excludePath);
    } finally {
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  });
}

function isWithin(root: string, candidate: string): boolean {
  const child = relative(root, candidate);
  return child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

function coded(code: string): Error & { code: string } {
  return Object.assign(new Error(code), { code });
}
