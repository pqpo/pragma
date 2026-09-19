import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, copyFile, lstat, mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

const MAX_SKILL_BYTES = 25 * 1024 * 1024;
const MAX_SKILL_FILES = 1_000;

export interface SkillWorkingTreeEntry {
  readonly path: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly executable: boolean;
}

export interface SkillWorkingTreeSnapshot {
  readonly hash: string;
  readonly entries: readonly SkillWorkingTreeEntry[];
  readonly totalBytes: number;
}

export class SkillWorkingTreeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "SkillWorkingTreeError";
  }
}

export function emptySkillWorkingTreeSnapshot(): SkillWorkingTreeSnapshot {
  return {
    hash: createHash("sha256").update(JSON.stringify([])).digest("hex"),
    entries: [],
    totalBytes: 0,
  };
}

export async function scanSkillWorkingTree(
  root: string,
  options: { readonly allowMissingSkillDocument?: boolean } = {},
): Promise<SkillWorkingTreeSnapshot> {
  const absoluteRoot = resolve(root);
  const entries: SkillWorkingTreeEntry[] = [];
  let totalBytes = 0;

  const visit = async (directory: string): Promise<void> => {
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children.toSorted((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, child.name);
      const logical = relative(absoluteRoot, absolute).split(sep).join("/");
      if (logical.startsWith("../") || logical === ".." || logical.includes("\0")) {
        throw new SkillWorkingTreeError(
          "skill_revision_invalid_entry_type",
          `Skill entry escapes the draft root: ${logical}`,
        );
      }
      const metadata = await lstat(absolute);
      if (metadata.isSymbolicLink() || (!metadata.isDirectory() && !metadata.isFile())) {
        throw new SkillWorkingTreeError(
          "skill_revision_invalid_entry_type",
          `Skill drafts only support regular files and directories: ${logical}`,
        );
      }
      if (metadata.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (metadata.nlink > 1) {
        throw new SkillWorkingTreeError(
          "skill_revision_invalid_entry_type",
          `Hard-linked Skill files are not supported: ${logical}`,
        );
      }
      if (entries.length >= MAX_SKILL_FILES) {
        throw new SkillWorkingTreeError(
          "skill_revision_size_limit",
          `Skill drafts may contain at most ${MAX_SKILL_FILES} files.`,
        );
      }
      totalBytes += metadata.size;
      if (totalBytes > MAX_SKILL_BYTES) {
        throw new SkillWorkingTreeError(
          "skill_revision_size_limit",
          `Skill drafts may contain at most ${MAX_SKILL_BYTES} bytes.`,
        );
      }
      const bytes = await readFile(absolute);
      entries.push({
        path: logical,
        sizeBytes: bytes.byteLength,
        sha256: createHash("sha256").update(bytes).digest("hex"),
        executable: (metadata.mode & 0o111) !== 0,
      });
    }
  };

  await visit(absoluteRoot);
  if (
    options.allowMissingSkillDocument !== true &&
    !entries.some((entry) => entry.path === "SKILL.md")
  ) {
    throw new SkillWorkingTreeError(
      "skill_revision_skill_document_missing",
      "Skill drafts require SKILL.md.",
    );
  }
  const hash = createHash("sha256")
    .update(
      JSON.stringify(
        entries.map((entry) => [entry.path, entry.sha256, entry.sizeBytes, entry.executable]),
      ),
    )
    .digest("hex");
  return { hash, entries, totalBytes };
}

export async function copySkillTree(source: string, target: string): Promise<void> {
  const sourceRoot = resolve(source);
  const targetRoot = resolve(target);
  await mkdir(targetRoot, { recursive: true, mode: 0o700 });
  const visit = async (directory: string): Promise<void> => {
    for (const child of await readdir(directory, { withFileTypes: true })) {
      const absolute = join(directory, child.name);
      const logical = relative(sourceRoot, absolute);
      const destination = resolve(targetRoot, logical);
      if (destination !== targetRoot && !destination.startsWith(`${targetRoot}${sep}`)) {
        throw new SkillWorkingTreeError(
          "skill_revision_invalid_entry_type",
          `Skill entry escapes the target root: ${logical}`,
        );
      }
      const metadata = await lstat(absolute);
      if (metadata.isDirectory()) {
        await mkdir(destination, { recursive: true, mode: 0o700 });
        await visit(absolute);
        continue;
      }
      if (!metadata.isFile() || metadata.isSymbolicLink()) {
        throw new SkillWorkingTreeError(
          "skill_revision_invalid_entry_type",
          `Skill drafts only support regular files and directories: ${logical}`,
        );
      }
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await copyFile(absolute, destination, constants.COPYFILE_FICLONE);
      await chmod(destination, metadata.mode & 0o777);
    }
  };
  await visit(sourceRoot);
}

export async function createStableSkillSubmission(input: {
  readonly worktreePath: string;
  readonly submissionsPath: string;
  readonly expectedHash: string;
}): Promise<{ readonly path: string; readonly snapshot: SkillWorkingTreeSnapshot }> {
  const before = await scanSkillWorkingTree(input.worktreePath);
  if (before.hash !== input.expectedHash) {
    throw new SkillWorkingTreeError(
      "skill_revision_working_tree_changed",
      "The Skill draft changed after it was inspected.",
    );
  }
  const temporary = join(input.submissionsPath, `.${before.hash}.${randomUUID()}.tmp`);
  const target = join(input.submissionsPath, before.hash);
  await mkdir(input.submissionsPath, { recursive: true, mode: 0o700 });
  try {
    await copySkillTree(input.worktreePath, temporary);
    const [copied, after] = await Promise.all([
      scanSkillWorkingTree(temporary),
      scanSkillWorkingTree(input.worktreePath),
    ]);
    if (copied.hash !== before.hash || after.hash !== before.hash) {
      throw new SkillWorkingTreeError(
        "skill_revision_working_tree_changed",
        "The Skill draft changed while its submission was being created.",
      );
    }
    try {
      await rename(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    return { path: target, snapshot: before };
  } finally {
    await rm(temporary, { recursive: true, force: true }).catch(() => undefined);
  }
}
