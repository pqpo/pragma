import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { promisify } from "node:util";

import { withFileLock } from "@pragma/core";
import { MAX_SKILL_PACKAGE_BYTES } from "@pragma/shared";
import { z } from "zod";

import {
  AssetGitBindSchema,
  AssetGitImportSchema,
  AssetGitSourceSchema,
  AssetGitStatusSchema,
  AssetGitTargetSchema,
  type AssetGitSource,
  type AssetGitStatus,
  type AssetGitTarget,
  type ContextStoreSnapshot,
} from "../../../shared/contracts/index.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";
import { scanSkillWorkingTree } from "../capabilities/skill-revision-draft-store.ts";
import { hashSnapshotContent } from "../context-stores/context-store-store.ts";

const execFileAsync = promisify(execFile);
const CommitSchema = z.string().regex(/^[a-f0-9]{40,64}$/u);
const RecordSchema = z.object({
  schemaVersion: z.literal("pragma.asset-git/v1"),
  target: AssetGitTargetSchema,
  source: AssetGitSourceSchema,
  baseRevision: z.number().int().positive().optional(),
  remoteCommit: CommitSchema.optional(),
  syncedAt: z.string().datetime().optional(),
  conflictPaths: z.array(z.string()).optional(),
  error: z.string().optional(),
});
const JournalSchema = z.object({
  schemaVersion: z.literal("pragma.asset-git-journal/v1"),
  target: AssetGitTargetSchema,
  source: AssetGitSourceSchema,
  baseRevision: z.number().int().positive(),
  remoteCommit: CommitSchema.optional(),
  phase: z.enum(["prepared", "pushed", "local_published"]),
  publishedRevision: z.number().int().positive().optional(),
});
type Record = z.infer<typeof RecordSchema>;
type Files = Map<string, Buffer>;

export interface AssetGitService {
  status(target: AssetGitTarget): Promise<AssetGitStatus>;
  bind(input: z.input<typeof AssetGitBindSchema>): Promise<AssetGitStatus>;
  unbind(target: AssetGitTarget): Promise<void>;
  import(input: z.input<typeof AssetGitImportSchema>): Promise<AssetGitTarget>;
  sync(target: AssetGitTarget): Promise<AssetGitStatus>;
  source(target: AssetGitTarget): Promise<AssetGitSource | undefined>;
  restoreSource(target: AssetGitTarget, source: AssetGitSource): Promise<void>;
}

export function createAssetGitService(options: {
  readonly stateRoot: string;
  readonly stores: ContextStoreStore;
  readonly capabilities: CapabilityStore;
  readonly afterPush?: (() => Promise<void>) | undefined;
  readonly onAssociationChanged?: ((target: AssetGitTarget) => void) | undefined;
}): AssetGitService {
  const recordPath = (target: AssetGitTarget) =>
    join(options.stateRoot, target.kind, `${target.id}.json`);
  const journalPath = (target: AssetGitTarget) => `${recordPath(target)}.journal`;
  const readJournal = async (target: AssetGitTarget) => {
    try {
      return JournalSchema.parse(JSON.parse(await readFile(journalPath(target), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const saveJournal = async (target: AssetGitTarget, journal: z.infer<typeof JournalSchema>) => {
    const path = journalPath(target);
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(JournalSchema.parse(journal))}\n`, {
      mode: 0o600,
    });
    try {
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const readRecord = async (target: AssetGitTarget): Promise<Record | undefined> => {
    try {
      return RecordSchema.parse(JSON.parse(await readFile(recordPath(target), "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const saveRecord = async (record: Record): Promise<void> => {
    const path = recordPath(record.target);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(RecordSchema.parse(record))}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
    } finally {
      await rm(temporary, { force: true });
    }
  };
  const withTargetLock = async <T>(
    target: AssetGitTarget,
    operation: () => Promise<T>,
  ): Promise<T> => {
    await mkdir(dirname(recordPath(target)), { recursive: true, mode: 0o700 });
    return await withFileLock(`${recordPath(target)}.lock`, operation);
  };
  const withBindingLock = async <T>(operation: () => Promise<T>): Promise<T> => {
    await mkdir(options.stateRoot, { recursive: true, mode: 0o700 });
    return await withFileLock(join(options.stateRoot, "bindings.lock"), operation);
  };
  const assertExists = async (target: AssetGitTarget): Promise<void> => {
    if (target.kind === "knowledge") {
      const snapshot = await options.stores.getSnapshot(target.id);
      if (
        [
          ...snapshot.directories,
          ...snapshot.files.map((file) => file.id),
          ...(await options.stores.listEntries(target.id)).map((entry) => entry.id),
        ].some((path) => path.split("/").some((segment) => segment.toLowerCase() === ".git"))
      ) {
        throw new Error(
          "This knowledge base contains historical .git files; remove them before Git sync.",
        );
      }
    } else {
      const capability = await options.capabilities.get(target.id);
      if (capability.definition.kind !== "skill" || capability.managedBy === "system") {
        throw new Error("Only user Skill capabilities can be associated with Git.");
      }
      if (
        (await options.capabilities.listSkillFiles({ id: target.id })).some((file) =>
          file.path.split("/").some((segment) => segment.toLowerCase() === ".git"),
        )
      ) {
        throw new Error(
          "This Skill contains historical .git files; remove them in a new revision before Git sync.",
        );
      }
    }
  };
  const assertUnique = async (target: AssetGitTarget, source: AssetGitSource): Promise<void> => {
    for (const kind of ["knowledge", "skill"] as const) {
      let names: string[];
      try {
        names = await readdir(join(options.stateRoot, kind));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        const other = RecordSchema.parse(
          JSON.parse(await readFile(join(options.stateRoot, kind, name), "utf8")),
        );
        if (other.target.kind === target.kind && other.target.id === target.id) continue;
        if (other.source.remote === source.remote && other.source.branch === source.branch) {
          throw new Error("This Git repository and branch are already associated with an asset.");
        }
      }
    }
  };
  const status = async (target: AssetGitTarget): Promise<AssetGitStatus> => {
    const record = await readRecord(AssetGitTargetSchema.parse(target));
    const currentRevision =
      record === undefined
        ? undefined
        : record.target.kind === "knowledge"
          ? (await options.stores.getSnapshot(record.target.id)).revision
          : (await options.capabilities.get(record.target.id)).manifest.latestRevision;
    return AssetGitStatusSchema.parse({
      target,
      ...(record === undefined
        ? {}
        : {
            source: record.source,
            syncedAt: record.syncedAt,
            conflictPaths: record.conflictPaths,
            error: record.error,
          }),
      status:
        record === undefined
          ? "unbound"
          : record.error !== undefined
            ? "error"
            : record.conflictPaths !== undefined
              ? "conflict"
              : record.syncedAt !== undefined && record.baseRevision === currentRevision
                ? "synced"
                : "pending",
    });
  };
  const bind = async (input: z.input<typeof AssetGitBindSchema>): Promise<AssetGitStatus> => {
    const { target, source } = AssetGitBindSchema.parse(input);
    return await withTargetLock(target, async () => {
      await assertExists(target);
      const previous = await readRecord(target);
      if (previous?.source.remote === source.remote && previous.source.branch === source.branch)
        return await status(target);
      if (await readJournal(target))
        throw new Error("Retry the interrupted Git sync before changing its address.");
      const branch = await withCheckout(source, async (_root, _commit, resolved) => resolved);
      await withBindingLock(async () => {
        await assertUnique(target, { remote: source.remote, branch });
        await saveRecord({
          schemaVersion: "pragma.asset-git/v1",
          target,
          source: { remote: source.remote, branch },
        });
      });
      options.onAssociationChanged?.(target);
      return await status(target);
    });
  };
  const unbind = async (target: AssetGitTarget): Promise<void> => {
    const parsed = AssetGitTargetSchema.parse(target);
    await withTargetLock(parsed, async () => {
      const previous = await readRecord(parsed);
      await rm(recordPath(parsed), { force: true });
      await rm(journalPath(parsed), { force: true });
      if (previous !== undefined) options.onAssociationChanged?.(parsed);
    });
  };
  const importAsset = async (
    input: z.input<typeof AssetGitImportSchema>,
  ): Promise<AssetGitTarget> => {
    const parsed = AssetGitImportSchema.parse(input);
    return await withCheckout(parsed.source, async (root, commit, branch) => {
      if (commit === undefined) throw new Error("Cannot import an empty Git repository.");
      const files = await readManagedFiles(root, parsed.kind);
      if (files.size === 0)
        throw new Error("The Git repository contains no supported asset files.");
      const source = { remote: parsed.source.remote, branch };
      return await withBindingLock(async () => {
        await assertUnique({ kind: parsed.kind, id: randomUUID() } as AssetGitTarget, source);
        let target: AssetGitTarget;
        if (parsed.kind === "knowledge") {
          const name = repositoryName(parsed.source.remote).slice(0, 50);
          const created = await options.stores.createFromSnapshot({
            name,
            description: "",
            author: "import",
            summary: "Import knowledge base from Git",
            files: [...files].map(([id, bytes]) => ({
              id,
              content: decodeMarkdown(bytes),
              metadata: { trigger: "manual" as const, priority: "normal" as const },
            })),
          });
          target = { kind: "knowledge", id: created.id };
          await saveRecord({
            schemaVersion: "pragma.asset-git/v1",
            target,
            source,
            baseRevision: created.contentRevision,
            remoteCommit: commit,
            syncedAt: new Date().toISOString(),
          });
          options.onAssociationChanged?.(target);
        } else {
          const stage = await mkdtemp(join(tmpdir(), "pragma-git-skill-"));
          try {
            await writeFiles(stage, files, await readGitModes(root));
            const created = await options.capabilities.importSkill({ sourcePath: stage });
            target = { kind: "skill", id: created.manifest.id };
            await saveRecord({
              schemaVersion: "pragma.asset-git/v1",
              target,
              source,
              baseRevision: created.manifest.latestRevision,
              remoteCommit: commit,
              syncedAt: new Date().toISOString(),
            });
            options.onAssociationChanged?.(target);
          } finally {
            await rm(stage, { recursive: true, force: true });
          }
        }
        return target;
      });
    });
  };
  const sync = async (rawTarget: AssetGitTarget): Promise<AssetGitStatus> => {
    const target = AssetGitTargetSchema.parse(rawTarget);
    return await withTargetLock(target, async () => {
      const record = await readRecord(target);
      if (record === undefined) throw new Error("Set a Git address before syncing this asset.");
      await assertExists(target);
      const journal = await readJournal(target);
      if (journal !== undefined) {
        if (
          journal.target.kind !== target.kind ||
          journal.target.id !== target.id ||
          journal.source.remote !== record.source.remote ||
          journal.source.branch !== record.source.branch
        ) {
          throw new Error("The interrupted Git sync journal does not match this asset.");
        }
        if (
          journal.publishedRevision !== undefined &&
          record.baseRevision === journal.publishedRevision &&
          record.remoteCommit === journal.remoteCommit
        ) {
          await rm(journalPath(target), { force: true });
        }
      }
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          return await withCheckout(record.source, async (root, head, branch) => {
            const current = await readLocalFiles(target, options.stores, options.capabilities);
            const remote = await readManagedFiles(root, target.kind);
            const base =
              record.baseRevision === undefined
                ? new Map<string, Buffer>()
                : (
                    await readLocalFiles(
                      target,
                      options.stores,
                      options.capabilities,
                      record.baseRevision,
                    )
                  ).files;
            const merged = await mergeFiles(base, current.files, remote);
            const modes =
              target.kind === "skill"
                ? await mergeSkillModes({
                    base:
                      record.baseRevision === undefined
                        ? undefined
                        : await options.capabilities.skillFilesPath(target.id, record.baseRevision),
                    local: await options.capabilities.skillFilesPath(target.id, current.revision),
                    remote: root,
                    baseFiles: base,
                    localFiles: current.files,
                    remoteFiles: remote,
                    mergedFiles: merged.files,
                  })
                : undefined;
            const conflicts = [...merged.conflicts, ...(modes?.conflicts ?? [])];
            if (conflicts.length > 0) {
              await saveRecord({
                ...record,
                source: { ...record.source, branch },
                conflictPaths: [...new Set(conflicts)].toSorted(),
                error: undefined,
              });
              return await status(target);
            }
            await replaceManagedFiles(root, remote, merged.files);
            await git(root, ["add", "-A"]);
            for (const path of merged.files.keys()) await git(root, ["add", "-f", "--", path]);
            if (modes) await applyModes(root, modes.merged);
            const changed = (await git(root, ["status", "--porcelain"])).trim() !== "";
            if (changed) await assertGitIdentity(root);
            await saveJournal(target, {
              schemaVersion: "pragma.asset-git-journal/v1",
              target,
              source: { ...record.source, branch },
              baseRevision: current.revision,
              remoteCommit: head,
              phase: "prepared",
            });
            let revision = current.revision;
            if (
              !sameFiles(current.files, merged.files) ||
              (modes !== undefined && !sameModes(modes.local, modes.merged))
            ) {
              revision = await publishLocal(
                target,
                current.revision,
                merged.files,
                modes?.merged,
                options.stores,
                options.capabilities,
              );
            }
            await saveJournal(target, {
              schemaVersion: "pragma.asset-git-journal/v1",
              target,
              source: { ...record.source, branch },
              baseRevision: current.revision,
              remoteCommit: head,
              phase: "local_published",
              publishedRevision: revision,
            });
            if (changed) {
              await git(root, ["commit", "-m", `Sync ${target.kind} asset`]);
              await git(root, ["push", "origin", `HEAD:refs/heads/${branch}`]);
            }
            const pushedCommit = changed
              ? CommitSchema.parse((await git(root, ["rev-parse", "HEAD"])).trim())
              : head;
            await saveJournal(target, {
              schemaVersion: "pragma.asset-git-journal/v1",
              target,
              source: { ...record.source, branch },
              baseRevision: current.revision,
              remoteCommit: pushedCommit,
              phase: "pushed",
              publishedRevision: revision,
            });
            await options.afterPush?.();
            await saveRecord({
              ...record,
              source: { ...record.source, branch },
              baseRevision: revision,
              remoteCommit: pushedCommit,
              syncedAt: new Date().toISOString(),
              conflictPaths: undefined,
              error: undefined,
            });
            await rm(journalPath(target), { force: true });
            return await status(target);
          });
        } catch (error) {
          if (attempt < 2 && isRemoteHeadRace(error)) continue;
          await saveRecord({
            ...record,
            error: error instanceof Error ? error.message : String(error),
            conflictPaths: undefined,
          });
          return await status(target);
        }
      }
      throw new Error("Git sync exceeded the retry limit.");
    });
  };
  return {
    status,
    bind,
    unbind,
    import: importAsset,
    sync,
    source: async (target) => (await readRecord(target))?.source,
    restoreSource: async (rawTarget, rawSource) => {
      const target = AssetGitTargetSchema.parse(rawTarget);
      const source = AssetGitSourceSchema.parse(rawSource);
      if (!source.branch) throw new Error("Restored Git association is missing its branch.");
      await withTargetLock(target, async () => {
        await assertExists(target);
        const previous = await readRecord(target);
        if (previous?.source.remote === source.remote && previous.source.branch === source.branch)
          return;
        if (await readJournal(target))
          throw new Error("Retry the interrupted Git sync before restoring another address.");
        await withBindingLock(async () => {
          await assertUnique(target, source);
          await saveRecord({ schemaVersion: "pragma.asset-git/v1", target, source });
        });
      });
    },
  };
}

async function git(root: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", root, ...args], {
    timeout: 60_000,
    maxBuffer: 32 * 1024 * 1024,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
      GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes",
    },
  });
  return stdout;
}

async function assertGitIdentity(root: string): Promise<void> {
  const [name, email] = await Promise.all([
    git(root, ["config", "--get", "user.name"]).catch(() => ""),
    git(root, ["config", "--get", "user.email"]).catch(() => ""),
  ]);
  if (!name.trim() || !email.trim()) {
    throw new Error("Set Git user.name and user.email before publishing this asset.");
  }
}

function isRemoteHeadRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /non-fast-forward|fetch first|failed to push some refs|stale info/iu.test(message);
}

async function withCheckout<T>(
  source: AssetGitSource,
  run: (root: string, commit: string | undefined, branch: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "pragma-asset-git-"));
  try {
    await git(root, ["init"]);
    await git(root, ["remote", "add", "origin", source.remote]);
    const advertised = await git(root, ["ls-remote", "--symref", "origin", "HEAD"]);
    const branch = AssetGitSourceSchema.shape.branch
      .unwrap()
      .parse(
        source.branch ?? /^ref: refs\/heads\/([^\t]+)\tHEAD/mu.exec(advertised)?.[1] ?? "main",
      );
    const heads = await git(root, ["ls-remote", "origin", `refs/heads/${branch}`]);
    let commit: string | undefined;
    if (heads.trim() !== "") {
      await git(root, ["fetch", "--depth=1", "origin", `refs/heads/${branch}`]);
      await git(root, ["checkout", "-B", branch, "FETCH_HEAD"]);
      commit = CommitSchema.parse((await git(root, ["rev-parse", "HEAD"])).trim());
    } else {
      if (advertised.trim() !== "") throw new Error(`Git branch does not exist: ${branch}`);
      await git(root, ["symbolic-ref", "HEAD", `refs/heads/${branch}`]);
    }
    return await run(root, commit, branch);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function readManagedFiles(root: string, kind: AssetGitTarget["kind"]): Promise<Files> {
  const files: Files = new Map();
  let totalBytes = 0;
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name.toLowerCase() === ".git") continue;
      const path = join(directory, entry.name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) {
        if (kind === "knowledge" && !entry.name.toLowerCase().endsWith(".md")) continue;
        throw new Error(`Git asset contains a symbolic link: ${entry.name}`);
      }
      if (info.isDirectory()) {
        await visit(path);
        continue;
      }
      if (!info.isFile()) throw new Error(`Git asset contains an unsupported entry: ${entry.name}`);
      const id = relative(root, path).split(sep).join("/");
      if (kind === "knowledge" && !id.toLowerCase().endsWith(".md")) continue;
      if (files.size >= (kind === "knowledge" ? 5_000 : 1_000)) {
        throw new Error("Git asset contains too many files.");
      }
      totalBytes += info.size;
      if (
        (kind === "knowledge" && info.size > 1_000_000) ||
        (kind === "skill" && totalBytes > MAX_SKILL_PACKAGE_BYTES)
      ) {
        throw new Error("Git asset exceeds the supported file size limit.");
      }
      const bytes = await readFile(path);
      if (kind === "knowledge") decodeMarkdown(bytes);
      files.set(id, bytes);
    }
  };
  await visit(root);
  return files;
}

async function readLocalFiles(
  target: AssetGitTarget,
  stores: ContextStoreStore,
  capabilities: CapabilityStore,
  revision?: number,
): Promise<{ files: Files; revision: number }> {
  if (target.kind === "knowledge") {
    const snapshot = await stores.getSnapshot(target.id, revision);
    return {
      files: new Map(snapshot.files.map((file) => [file.id, Buffer.from(file.content)])),
      revision: snapshot.revision,
    };
  }
  const capability = await capabilities.get(target.id, revision);
  if (capability.definition.kind !== "skill") throw new Error("Git target is not a Skill.");
  return {
    files: await readManagedFiles(
      await capabilities.skillFilesPath(target.id, capability.manifest.latestRevision),
      "skill",
    ),
    revision: capability.manifest.latestRevision,
  };
}

async function mergeFiles(
  base: Files,
  local: Files,
  remote: Files,
): Promise<{ files: Files; conflicts: string[] }> {
  const output: Files = new Map();
  const conflicts: string[] = [];
  for (const path of new Set([...base.keys(), ...local.keys(), ...remote.keys()])) {
    const old = base.get(path),
      ours = local.get(path),
      theirs = remote.get(path);
    const equal = (a: Buffer | undefined, b: Buffer | undefined) =>
      a === undefined ? b === undefined : b !== undefined && a.equals(b);
    if (equal(ours, theirs)) {
      if (ours !== undefined) output.set(path, ours);
      continue;
    }
    if (equal(ours, old)) {
      if (theirs !== undefined) output.set(path, theirs);
      continue;
    }
    if (equal(theirs, old)) {
      if (ours !== undefined) output.set(path, ours);
      continue;
    }
    if (
      ours === undefined ||
      theirs === undefined ||
      old === undefined ||
      !isText(old) ||
      !isText(ours) ||
      !isText(theirs)
    ) {
      conflicts.push(path);
      continue;
    }
    const merged = await mergeText(old, ours, theirs);
    if (merged === undefined) conflicts.push(path);
    else output.set(path, merged);
  }
  for (const path of output.keys()) {
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      const ancestor = segments.slice(0, length).join("/");
      if (output.has(ancestor)) conflicts.push(ancestor, path);
    }
  }
  return { files: output, conflicts };
}

function isText(bytes: Buffer): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
async function mergeText(base: Buffer, ours: Buffer, theirs: Buffer): Promise<Buffer | undefined> {
  const root = await mkdtemp(join(tmpdir(), "pragma-merge-"));
  try {
    await Promise.all(
      [
        ["base", base],
        ["ours", ours],
        ["theirs", theirs],
      ].map(async ([name, bytes]) => await writeFile(join(root, name as string), bytes as Buffer)),
    );
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["merge-file", "-p", "ours", "base", "theirs"],
        {
          cwd: root,
          encoding: "buffer",
          timeout: 60_000,
          maxBuffer: MAX_SKILL_PACKAGE_BYTES * 3,
        },
      );
      return Buffer.from(stdout);
    } catch (error) {
      if ((error as NodeJS.ErrnoException & { code?: number }).code === 1) return undefined;
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function replaceManagedFiles(root: string, before: Files, after: Files): Promise<void> {
  for (const path of before.keys()) if (!after.has(path)) await rm(join(root, ...path.split("/")));
  for (const [path, bytes] of after) {
    await assertSafeWritePath(root, path);
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes);
  }
}
async function assertSafeWritePath(root: string, path: string): Promise<void> {
  const segments = path.split("/");
  for (let length = 1; length <= segments.length; length += 1) {
    try {
      if ((await lstat(join(root, ...segments.slice(0, length)))).isSymbolicLink()) {
        throw new Error(`Git asset path crosses a symbolic link: ${path}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}
async function writeFiles(root: string, files: Files, modes?: Modes): Promise<void> {
  for (const [path, bytes] of files) {
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    await writeFile(target, bytes);
    if (modes) {
      const executable = modes.get(path);
      if (executable === undefined)
        throw new Error(`Git index is missing the Skill file mode: ${path}`);
      await chmod(target, executable ? 0o700 : 0o600);
    }
  }
}
type Modes = Map<string, boolean>;
async function readGitModes(root: string): Promise<Modes> {
  const modes: Modes = new Map();
  const index = await git(root, ["ls-files", "--stage", "-z"]);
  for (const record of index.split("\0")) {
    if (!record) continue;
    const match = /^(100644|100755) [a-f0-9]+ [0-3]\t([\s\S]+)$/u.exec(record);
    if (match) modes.set(match[2]!, match[1] === "100755");
  }
  return modes;
}
async function readModes(root: string, files: Files): Promise<Modes> {
  return new Map(
    await Promise.all(
      [...files.keys()].map(
        async (path) =>
          [path, Boolean((await stat(join(root, ...path.split("/")))).mode & 0o111)] as const,
      ),
    ),
  );
}
async function mergeSkillModes(input: {
  readonly base?: string | undefined;
  readonly local: string;
  readonly remote: string;
  readonly baseFiles: Files;
  readonly localFiles: Files;
  readonly remoteFiles: Files;
  readonly mergedFiles: Files;
}): Promise<{ local: Modes; merged: Modes; conflicts: string[] }> {
  const [base, local, remote] = await Promise.all([
    input.base
      ? readModes(input.base, input.baseFiles)
      : Promise.resolve(new Map<string, boolean>()),
    readModes(input.local, input.localFiles),
    readGitModes(input.remote),
  ]);
  const merged: Modes = new Map();
  const conflicts: string[] = [];
  for (const path of input.mergedFiles.keys()) {
    const old = base.get(path),
      ours = local.get(path),
      theirs = remote.get(path);
    const selected =
      ours === theirs ? ours : ours === old ? theirs : theirs === old ? ours : undefined;
    if (selected === undefined) conflicts.push(path);
    else merged.set(path, selected);
  }
  return { local, merged, conflicts };
}
async function applyModes(root: string, modes: Modes): Promise<void> {
  for (const [path, executable] of modes) {
    await chmod(join(root, ...path.split("/")), executable ? 0o700 : 0o600);
    await git(root, ["update-index", `--chmod=${executable ? "+x" : "-x"}`, "--", path]);
  }
}
function sameModes(a: Modes, b: Modes): boolean {
  return a.size === b.size && [...a].every(([path, mode]) => b.get(path) === mode);
}
function sameFiles(a: Files, b: Files): boolean {
  return (
    a.size === b.size &&
    [...a].every(([path, bytes]) => {
      const other = b.get(path);
      return other !== undefined && bytes.equals(other);
    })
  );
}
function decodeMarkdown(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
async function publishLocal(
  target: AssetGitTarget,
  baseRevision: number,
  files: Files,
  modes: Modes | undefined,
  stores: ContextStoreStore,
  capabilities: CapabilityStore,
): Promise<number> {
  if (target.kind === "knowledge") {
    const current = await stores.getSnapshot(target.id);
    if (current.revision !== baseRevision)
      throw new Error("Knowledge base changed during Git sync.");
    const metadata = new Map(current.files.map((file) => [file.id, file.metadata]));
    const nextFiles: ContextStoreSnapshot["files"] = [...files].map(([id, bytes]) => ({
      id,
      content: decodeMarkdown(bytes),
      metadata: metadata.get(id) ?? { trigger: "manual", priority: "normal" },
    }));
    const directories = new Set(current.directories);
    for (const file of nextFiles) {
      const segments = file.id.split("/");
      for (let length = 1; length < segments.length; length += 1) {
        directories.add(segments.slice(0, length).join("/"));
      }
    }
    const nextDirectories = [...directories].toSorted();
    const result = await stores.appendSnapshot(
      {
        storeId: target.id,
        baseRevision,
        baseSnapshotHash: current.snapshotHash,
        snapshotHash: hashSnapshotContent(nextFiles, nextDirectories),
        directories: nextDirectories,
        files: nextFiles,
        summary: "Sync knowledge base from Git",
      },
      "sync",
    );
    return result.contentRevision;
  }
  const current = await capabilities.get(target.id);
  if (current.manifest.latestRevision !== baseRevision || current.definition.kind !== "skill")
    throw new Error("Skill changed during Git sync.");
  const stage = await mkdtemp(join(tmpdir(), "pragma-git-skill-"));
  try {
    await writeFiles(stage, files, modes);
    const snapshot = await scanSkillWorkingTree(stage);
    const result = await capabilities.publishSkillRevisionCandidate({
      id: target.id,
      baseRevision,
      baseContentHash: current.definition.contentHash,
      sourcePath: stage,
      candidateContentHash: snapshot.hash,
    });
    return result.manifest.latestRevision;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
function repositoryName(remote: string): string {
  return basename(remote.replace(/\.git$/u, "").replace(/\/$/u, "")) || "Git knowledge base";
}
