import { z } from "zod";
import {
  ContextStoreSchema,
  ContextStoreSnapshotSchema,
  SkillCapabilityDefinitionSchema,
  type ContextStoreSnapshot,
} from "../../deployment-contracts/index.ts";
import { isGitMetadataPath } from "../../deployment-contracts/git-metadata-path.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateSkillPackage } from "@pragma/built-in-agents";
import { MAX_SKILL_PACKAGE_BYTES } from "@pragma/shared";
import { readSkillFrontmatter } from "../capabilities/skill-frontmatter.ts";
import { scanSkillWorkingTree } from "../capabilities/skill-revision-draft-store.ts";
import type { CapabilityStore } from "../capabilities/capability-store.ts";
import { hashSnapshotContent } from "../context-stores/context-store-store.ts";
import type { ContextStoreStore } from "../context-stores/context-store-store.ts";

/** Binary-safe transfer representation. Base64 is private to memory/journals, never written to Git. */
export const SkillFileSchema = z
  .object({
    path: z
      .string()
      .min(1)
      .max(2_000)
      .refine(
        (path) =>
          !path.startsWith("/") &&
          !path.includes("\\") &&
          path
            .split("/")
            .every(
              (segment) =>
                segment !== "" &&
                segment !== "." &&
                segment !== ".." &&
                segment.toLowerCase() !== ".git",
            ),
      ),
    content: z.string(),
    executable: z.boolean(),
  })
  .strict();
export const SkillDataSchema = z
  .object({
    name: SkillCapabilityDefinitionSchema.shape.name,
    description: SkillCapabilityDefinitionSchema.shape.description,
    files: z.array(SkillFileSchema).min(1).max(1_000),
  })
  .strict();
export const KnowledgeDataSchema = z
  .object({
    name: ContextStoreSchema.shape.name,
    description: ContextStoreSchema.shape.description,
    directories: ContextStoreSnapshotSchema.shape.directories,
    files: ContextStoreSnapshotSchema.shape.files,
  })
  .strict();
export type TransferredSkillFile = z.infer<typeof SkillFileSchema>;
export interface TransferredSkillValidationContext {
  readonly id: string;
}
export async function readTransferredSkill(root: string, executablePaths?: readonly string[]) {
  const tree = await scanSkillWorkingTree(
    root,
    executablePaths === undefined ? {} : { executablePaths: new Set(executablePaths) },
  );
  const files = await Promise.all(
    tree.entries.map(async (entry) => ({
      path: entry.path,
      content: (await readFile(join(root, entry.path))).toString("base64"),
      executable: entry.executable,
    })),
  );
  return { entries: tree.entries, files: files.sort((a, b) => a.path.localeCompare(b.path)) };
}
export function validateTransferredSkill(
  data: {
    readonly name: string;
    readonly description: string;
    readonly files: readonly TransferredSkillFile[];
  },
  context: TransferredSkillValidationContext,
): z.infer<typeof SkillDataSchema> {
  const location = `pragma-sync/skills/${context.id}`;
  const identity = `Skill ${JSON.stringify(data.name)} (ID ${context.id}, ${location})`;
  let totalBytes = 0;
  const files = data.files.map((file) => {
    const bytes = Buffer.from(file.content, "base64");
    totalBytes += bytes.byteLength;
    if (totalBytes > MAX_SKILL_PACKAGE_BYTES)
      throw new Error(`Invalid ${identity}: package exceeds 25 MiB.`);
    // Only the entry document needs text decoding. All payload bytes count above, including
    // binary files whose replacement characters would otherwise inflate the UTF-8 size.
    let content = "";
    if (file.path === "SKILL.md") {
      content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes))
        throw new Error(`Invalid ${identity} at SKILL.md: entry must be valid UTF-8 text.`);
    }
    return { path: file.path, content };
  });
  const metadata = readSkillFrontmatter(
    files.find((file) => file.path === "SKILL.md")?.content ?? "",
  );
  const description = metadata.description ?? "";
  const validation = validateSkillPackage({ name: data.name, description, files });
  if (!validation.passed) {
    const diagnostic = validation.diagnostics[0];
    throw new Error(
      `Invalid ${identity}${diagnostic?.path ? ` at ${diagnostic.path}` : ""}: ${
        diagnostic?.message ?? "Unknown validation error."
      }`,
    );
  }
  return SkillDataSchema.parse({ ...data, description });
}
export async function publishTransferredSkill(
  store: CapabilityStore,
  input: {
    readonly id: string;
    readonly name: string;
    readonly description: string;
    readonly sourcePath: string;
    readonly candidateContentHash: string;
    readonly executablePaths?: readonly string[];
    readonly current?: Awaited<ReturnType<CapabilityStore["get"]>>;
  },
) {
  const common = {
    id: input.id,
    sourcePath: input.sourcePath,
    candidateContentHash: input.candidateContentHash,
    ...(input.executablePaths === undefined ? {} : { executablePaths: [...input.executablePaths] }),
  };
  if (input.current === undefined) {
    const metadata = readSkillFrontmatter(
      await readFile(join(input.sourcePath, "SKILL.md"), "utf8"),
    );
    return await store.publishNewSkillRevisionCandidate({
      ...common,
      name: input.name,
      description: metadata.description ?? input.description,
    });
  }
  if (input.current.definition.kind !== "skill")
    throw new Error(`Capability ${input.id} is not a Skill.`);
  return await store.publishSkillRevisionCandidate({
    ...common,
    baseRevision: input.current.manifest.latestRevision,
    baseContentHash: input.current.definition.contentHash,
  });
}
export async function appendTransferredKnowledge(
  store: ContextStoreStore,
  input: Parameters<ContextStoreStore["appendSnapshot"]>[0],
  author: Parameters<ContextStoreStore["appendSnapshot"]>[1],
) {
  if (hashSnapshotContent(input.files, [...input.directories]) !== input.snapshotHash)
    throw new Error("The imported knowledge-base snapshot does not match its declared hash.");
  const current = (await store.list()).find((entry) => entry.id === input.storeId);
  if (current !== undefined) {
    const { snapshot, files, directories } = await readTransferredKnowledge(store, input.storeId);
    if (
      hashSnapshotContent(files, directories) === input.snapshotHash &&
      (input.name === undefined || input.name === current.name) &&
      (input.description === undefined || input.description === current.description)
    )
      return current;
    // Git metadata belongs to local storage, not the portable transfer. Preserve it
    // when applying remote edits without changing the immutable source snapshot.
    const retainedDirectories = snapshot.directories.filter(isGitMetadataPath);
    const retainedFiles = snapshot.files.filter((file) => isGitMetadataPath(file.id));
    const mergedDirectories = new Set([...input.directories, ...retainedDirectories]);
    for (const path of [...retainedDirectories, ...retainedFiles.map((file) => file.id)]) {
      const parts = path.split("/");
      for (let i = 1; i < parts.length; i++) mergedDirectories.add(parts.slice(0, i).join("/"));
    }
    const mergedFiles = [...input.files, ...retainedFiles];
    const directoriesToWrite = [...mergedDirectories].sort();
    return await store.appendSnapshot(
      {
        ...input,
        directories: directoriesToWrite,
        files: mergedFiles,
        snapshotHash: hashSnapshotContent(mergedFiles, directoriesToWrite),
      },
      author,
    );
  }
  return await store.appendSnapshot(input, author);
}

export async function readTransferredKnowledge(store: ContextStoreStore, id: string) {
  const snapshot = await store.getSnapshot(id);
  return { snapshot, ...portableKnowledgeContent(snapshot) };
}

/** Keep historical Git metadata in authority snapshots, outside portable assets. */
export function portableKnowledgeContent(
  snapshot: Pick<ContextStoreSnapshot, "files" | "directories">,
) {
  return {
    files: snapshot.files.filter((file) => !isGitMetadataPath(file.id)),
    directories: snapshot.directories.filter((path) => !isGitMetadataPath(path)),
  };
}
