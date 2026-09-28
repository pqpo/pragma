import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rmdir,
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
  CONTEXT_STORE_FILE_MAX_BYTES,
  assetGitManualContentSizeIssue,
  AssetGitBindSchema,
  AssetGitConflictsSchema,
  ResolveAssetGitConflictsSchema,
  type AssetGitConflicts,
  type ResolveAssetGitConflicts,
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
import { assertAssetGitIdentity, runAssetGit } from "./asset-git-command.ts";

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
  conflicts(target: AssetGitTarget): Promise<AssetGitConflicts>;
  resolve(input: ResolveAssetGitConflicts): Promise<AssetGitStatus>;
  sync(target: AssetGitTarget): Promise<AssetGitStatus>;
  source(target: AssetGitTarget): Promise<AssetGitSource | undefined>;
  listTargets(): Promise<readonly AssetGitTarget[]>;
  restoreSource(target: AssetGitTarget, source: AssetGitSource): Promise<void>;
}

export function createAssetGitService(options: {
  readonly stateRoot: string;
  readonly stores: ContextStoreStore;
  readonly capabilities: CapabilityStore;
  readonly afterPush?: (() => Promise<void>) | undefined;
  readonly onAssociationChanged?: ((target: AssetGitTarget) => void) | undefined;
  readonly onStatusChanged?: ((status: AssetGitStatus) => void) | undefined;
  readonly warn?: ((message: string, error: unknown) => void) | undefined;
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
        await containsGitMetadata(
          await options.capabilities.skillFilesPath(target.id, capability.manifest.latestRevision),
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
  const publishStatus = async (target: AssetGitTarget): Promise<AssetGitStatus> => {
    const next = await status(target);
    options.onStatusChanged?.(next);
    return next;
  };
  const bind = async (input: z.input<typeof AssetGitBindSchema>): Promise<AssetGitStatus> => {
    const { target, source } = AssetGitBindSchema.parse(input);
    const next = await withTargetLock(target, async () => {
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
    options.onStatusChanged?.(next);
    return next;
  };
  const unbind = async (target: AssetGitTarget): Promise<void> => {
    const parsed = AssetGitTargetSchema.parse(target);
    await withTargetLock(parsed, async () => {
      const previous = await readRecord(parsed);
      await rm(recordPath(parsed), { force: true });
      await rm(journalPath(parsed), { force: true });
      if (previous !== undefined) options.onAssociationChanged?.(parsed);
    });
    await publishStatus(parsed);
  };
  const importAsset = async (
    input: z.input<typeof AssetGitImportSchema>,
  ): Promise<AssetGitTarget> => {
    const parsed = AssetGitImportSchema.parse(input);
    const target = await withCheckout(parsed.source, async (root, commit, branch) => {
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
            const modes = await readGitModes(root);
            await writeFiles(stage, files, modes);
            const created = await options.capabilities.importSkill(
              { sourcePath: stage },
              { executablePaths: executablePaths(files, modes) },
            );
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
    await publishStatus(target);
    return target;
  };
  const inspect = async (
    target: AssetGitTarget,
    record: Record,
    root: string,
    head: string | undefined,
  ) => {
    const current = await readLocalFiles(target, options.stores, options.capabilities);
    const remote = await readManagedFiles(root, target.kind);
    const baseSnapshot =
      record.baseRevision === undefined
        ? undefined
        : await readLocalFiles(target, options.stores, options.capabilities, record.baseRevision);
    const base = baseSnapshot?.files ?? new Map<string, Buffer>();
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
            baseModes: baseSnapshot?.modes,
            localModes: current.modes,
          })
        : undefined;
    const conflicts = [...merged.conflicts, ...(modes?.conflicts ?? [])];
    const remoteModes = target.kind === "skill" ? await readGitModes(root) : undefined;
    const paths = [...new Set(conflicts)].toSorted();
    const conflictingPaths = new Set(paths);
    const snapshot = createHash("sha256")
      .update(
        JSON.stringify({
          target,
          source: record.source,
          baseRevision: record.baseRevision,
          remoteCommit: record.remoteCommit,
          localRevision: current.revision,
          head,
        }),
      )
      .digest("hex");
    const preview = AssetGitConflictsSchema.parse({
      target,
      snapshot,
      nonConflictingSizeBytes: [...merged.files].reduce(
        (total, [path, bytes]) => total + (conflictingPaths.has(path) ? 0 : bytes.byteLength),
        0,
      ),
      files: await Promise.all(
        paths.map(async (path) => {
          const old = base.get(path),
            ours = current.files.get(path),
            theirs = remote.get(path);
          const text = [old, ours, theirs].every((bytes) => bytes === undefined || isText(bytes));
          const [mergeLocal, mergeRemote] =
            text && old !== undefined && ours !== undefined && theirs !== undefined
              ? await Promise.all([
                  mergeText(old, ours, theirs, "ours"),
                  mergeText(old, ours, theirs, "theirs"),
                ])
              : [ours, theirs];
          return {
            path,
            kind: text ? "text" : "binary",
            mergeLocal: text && mergeLocal !== undefined ? mergeLocal.toString("utf8") : null,
            mergeRemote: text && mergeRemote !== undefined ? mergeRemote.toString("utf8") : null,
            base: text && old !== undefined ? old.toString("utf8") : null,
            local: text && ours !== undefined ? ours.toString("utf8") : null,
            remote: text && theirs !== undefined ? theirs.toString("utf8") : null,
            localSizeBytes: ours?.byteLength ?? 0,
            remoteSizeBytes: theirs?.byteLength ?? 0,
            localDeleted: ours === undefined,
            remoteDeleted: theirs === undefined,
            modeConflict: modes?.conflicts.includes(path) ?? false,
            localExecutable: modes?.local.get(path),
            remoteExecutable: remoteModes?.get(path),
          };
        }),
      ),
    });
    return { current, remote, merged, modes, remoteModes, preview };
  };
  const conflicts = async (rawTarget: AssetGitTarget): Promise<AssetGitConflicts> => {
    const target = AssetGitTargetSchema.parse(rawTarget);
    return await withTargetLock(target, async () => {
      const record = await readRecord(target);
      if (record === undefined) throw new Error("Set a Git address before syncing this asset.");
      await assertExists(target);
      return await withCheckout(record.source, async (root, head) => {
        const { preview } = await inspect(target, record, root, head);
        return preview;
      });
    });
  };
  const sync = async (
    rawTarget: AssetGitTarget,
    resolution?: ResolveAssetGitConflicts,
  ): Promise<AssetGitStatus> => {
    const target = AssetGitTargetSchema.parse(rawTarget);
    const current = await status(target);
    if (current.source !== undefined) {
      options.onStatusChanged?.({ ...current, status: "syncing" });
    }
    const next = await withTargetLock(target, async () => {
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
            const { current, remote, merged, modes, remoteModes, preview } = await inspect(
              target,
              record,
              root,
              head,
            );
            let conflictPaths = preview.files.map((file) => file.path);
            // A published local revision is the durable merge result. Resume it
            // only while both sides still match the journal's exact snapshot.
            if (
              resolution === undefined &&
              journal?.publishedRevision === current.revision &&
              journal.remoteCommit === head &&
              (journal.phase === "local_published" || journal.phase === "pushed")
            ) {
              merged.files.clear();
              for (const [path, bytes] of current.files) merged.files.set(path, bytes);
              if (modes) {
                modes.merged.clear();
                for (const [path, executable] of modes.local) modes.merged.set(path, executable);
              }
              conflictPaths = [];
            }
            if (resolution !== undefined) {
              if (resolution.snapshot !== preview.snapshot) {
                throw Object.assign(
                  new Error("Git conflict snapshot changed. Reload conflicts before applying."),
                  { code: "asset_git_stale_conflict" },
                );
              }
              const decisions = new Map(resolution.resolutions.map((item) => [item.path, item]));
              if (
                decisions.size !== resolution.resolutions.length ||
                decisions.size !== conflictPaths.length ||
                conflictPaths.some((path) => !decisions.has(path))
              ) {
                throw new Error("Resolve every conflicting file exactly once.");
              }
              for (const file of preview.files) {
                const decision = decisions.get(file.path)!;
                const bytes =
                  decision.choice === "manual"
                    ? Buffer.from(decision.content, "utf8")
                    : decision.choice === "delete"
                      ? undefined
                      : decision.choice === "local"
                        ? current.files.get(file.path)
                        : remote.get(file.path);
                if (decision.choice === "manual" && (file.kind !== "text" || !isText(bytes!))) {
                  throw new Error(`Manual merging requires a UTF-8 text file: ${file.path}`);
                }
                if (
                  decision.choice === "manual" &&
                  /^(?:<{7}|={7}|>{7})(?: |$)/mu.test(decision.content)
                ) {
                  throw new Error(`Remove conflict markers before applying: ${file.path}`);
                }
                if (bytes === undefined) {
                  merged.files.delete(file.path);
                  modes?.merged.delete(file.path);
                } else {
                  merged.files.set(file.path, bytes);
                  if (modes) {
                    if (
                      decision.choice === "manual" &&
                      file.modeConflict &&
                      decision.executable === undefined
                    ) {
                      throw new Error(`Choose the executable flag for: ${file.path}`);
                    }
                    const executable =
                      decision.choice === "manual"
                        ? (decision.executable ??
                          modes.merged.get(file.path) ??
                          modes.local.get(file.path) ??
                          remoteModes?.get(file.path) ??
                          false)
                        : decision.choice === "local"
                          ? modes.local.get(file.path)
                          : remoteModes?.get(file.path);
                    modes.merged.set(file.path, executable ?? false);
                  }
                }
              }
              conflictPaths = [];
            }
            if (conflictPaths.length > 0) {
              await saveRecord({
                ...record,
                source: { ...record.source, branch },
                conflictPaths,
                error: undefined,
              });
              return await status(target);
            }
            assertResolvedTree(merged.files, target.kind);
            await replaceManagedFiles(root, remote, merged.files);
            await git(root, ["add", "-A"]);
            for (const path of merged.files.keys()) await git(root, ["add", "-f", "--", path]);
            if (modes) await applyModes(root, modes.merged);
            const changed = (await git(root, ["status", "--porcelain"])).trim() !== "";
            if (changed) await assertAssetGitIdentity(root);
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
          if (
            resolution !== undefined &&
            (isRemoteHeadRace(error) ||
              (error as { code?: string }).code === "asset_git_stale_conflict")
          ) {
            await saveRecord({ ...record, conflictPaths: undefined, error: undefined });
            await publishStatus(target);
            throw Object.assign(
              new Error("Git conflict snapshot changed. Reload conflicts before applying."),
              { code: "asset_git_stale_conflict" },
            );
          }
          if (attempt < 2 && isRemoteHeadRace(error)) continue;
          options.warn?.(`Git synchronization failed for ${target.kind}/${target.id}.`, error);
          await saveRecord({
            ...record,
            error: error instanceof Error ? error.message : String(error),
            conflictPaths: undefined,
          });
          const failure = await status(target);
          if (resolution === undefined) return failure;
          const message = error instanceof Error ? error.message : String(error);
          const errorPath =
            resolution.resolutions.find((item) => message.includes(item.path))?.path ??
            (target.kind === "skill" && (error instanceof z.ZodError || /skill/i.test(message))
              ? "SKILL.md"
              : undefined);
          return { ...failure, ...(errorPath === undefined ? {} : { errorPath }) };
        }
      }
      throw new Error("Git sync exceeded the retry limit.");
    });
    options.onStatusChanged?.(next);
    return next;
  };
  const listTargets = async (): Promise<readonly AssetGitTarget[]> => {
    const targets: AssetGitTarget[] = [];
    for (const kind of ["knowledge", "skill"] as const) {
      let names: string[];
      try {
        names = await readdir(join(options.stateRoot, kind));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names.filter((item) => item.endsWith(".json"))) {
        try {
          const record = RecordSchema.parse(
            JSON.parse(await readFile(join(options.stateRoot, kind, name), "utf8")),
          );
          targets.push(record.target);
        } catch (error) {
          options.warn?.(`Could not read the Git association for ${kind}/${name}.`, error);
        }
      }
    }
    return targets;
  };
  return {
    status,
    bind,
    unbind,
    import: importAsset,
    sync,
    conflicts,
    resolve: async (input) => {
      const parsed = ResolveAssetGitConflictsSchema.parse(input);
      return await sync(parsed.target, parsed);
    },
    listTargets,
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
      await publishStatus(target);
    },
  };
}

async function git(root: string, args: string[]): Promise<string> {
  return await runAssetGit(root, args);
}

function isRemoteHeadRace(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /non-fast-forward|fetch first|stale info/iu.test(message);
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
        (kind === "knowledge" && info.size > CONTEXT_STORE_FILE_MAX_BYTES) ||
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
): Promise<{ files: Files; revision: number; modes?: Modes }> {
  if (target.kind === "knowledge") {
    const snapshot = await stores.getSnapshot(target.id, revision);
    return {
      files: new Map(snapshot.files.map((file) => [file.id, Buffer.from(file.content)])),
      revision: snapshot.revision,
    };
  }
  const capability = await capabilities.get(target.id, revision);
  if (capability.definition.kind !== "skill") throw new Error("Git target is not a Skill.");
  const files = await readManagedFiles(
    await capabilities.skillFilesPath(target.id, capability.manifest.latestRevision),
    "skill",
  );
  const executable = capability.definition.executablePaths;
  return {
    files,
    revision: capability.manifest.latestRevision,
    ...(executable !== undefined
      ? {
          modes: new Map([...files.keys()].map((path) => [path, executable.includes(path)])),
        }
      : {}),
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
async function mergeText(
  base: Buffer,
  ours: Buffer,
  theirs: Buffer,
  favor?: "ours" | "theirs",
): Promise<Buffer | undefined> {
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
        [
          "merge-file",
          "-p",
          ...(favor === undefined ? [] : [`--${favor}`]),
          "ours",
          "base",
          "theirs",
        ],
        {
          cwd: root,
          encoding: "buffer",
          timeout: 60_000,
          maxBuffer: MAX_SKILL_PACKAGE_BYTES * 3,
        },
      );
      return Buffer.from(stdout);
    } catch (error) {
      const code = (error as { code?: number }).code;
      // merge-file returns the number of conflicts (capped at 127), not just 1.
      if (typeof code === "number" && code > 0 && code <= 127) return undefined;
      throw error;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
async function replaceManagedFiles(root: string, before: Files, after: Files): Promise<void> {
  for (const path of before.keys()) {
    if (after.has(path)) continue;
    const target = join(root, ...path.split("/"));
    await rm(target);
    // Remove only empty managed parents; unrelated files must never be deleted.
    for (let parent = dirname(target); parent !== root; parent = dirname(parent)) {
      try {
        await rmdir(parent);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOTEMPTY" || code === "EEXIST") break;
        if (code !== "ENOENT") throw error;
      }
    }
  }
  for (const [path, bytes] of after) {
    await assertSafeWritePath(root, path);
    const target = join(root, ...path.split("/"));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const existing = await lstat(target).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (existing?.isDirectory()) await rmdir(target);
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
function executablePaths(files: Files, modes: Modes): string[] {
  return [...files.keys()].filter((path) => modes.get(path) === true).toSorted();
}

async function containsGitMetadata(root: string): Promise<boolean> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.name.toLowerCase() === ".git") return true;
    if (entry.isDirectory() && (await containsGitMetadata(join(root, entry.name)))) return true;
  }
  return false;
}
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
  readonly baseModes?: Modes | undefined;
  readonly localModes?: Modes | undefined;
}): Promise<{ local: Modes; merged: Modes; conflicts: string[] }> {
  const [base, local, remote] = await Promise.all([
    input.baseModes ??
      (input.base
        ? readModes(input.base, input.baseFiles)
        : Promise.resolve(new Map<string, boolean>())),
    input.localModes ?? readModes(input.local, input.localFiles),
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
    const directories = new Set(
      current.directories.filter((path) => {
        const segments = path.split("/");
        return !segments.some((_segment, index) =>
          files.has(segments.slice(0, index + 1).join("/")),
        );
      }),
    );
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
    const executable = modes === undefined ? undefined : executablePaths(files, modes);
    const snapshot = await scanSkillWorkingTree(
      stage,
      executable === undefined ? {} : { executablePaths: new Set(executable) },
    );
    const result = await capabilities.publishSkillRevisionCandidate({
      id: target.id,
      baseRevision,
      baseContentHash: current.definition.contentHash,
      sourcePath: stage,
      candidateContentHash: snapshot.hash,
      ...(executable === undefined ? {} : { executablePaths: executable }),
    });
    return result.manifest.latestRevision;
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}
function repositoryName(remote: string): string {
  return basename(remote.replace(/\.git$/u, "").replace(/\/$/u, "")) || "Git knowledge base";
}

function assertResolvedTree(files: Files, kind: AssetGitTarget["kind"]): void {
  let total = 0;
  for (const [path, bytes] of files) {
    total += bytes.length;
    if (kind === "knowledge" && assetGitManualContentSizeIssue(kind, decodeMarkdown(bytes)))
      throw new Error(`Knowledge file exceeds the supported size limit: ${path}`);
    const segments = path.split("/");
    for (let length = 1; length < segments.length; length += 1) {
      if (files.has(segments.slice(0, length).join("/"))) {
        throw new Error(`Choose between the file and its child files: ${path}`);
      }
    }
  }
  if (kind === "skill" && total > MAX_SKILL_PACKAGE_BYTES)
    throw new Error("The merged asset exceeds the size limit.");
}
