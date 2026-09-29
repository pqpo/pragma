import { z } from "zod";
import {
  ContextStoreSchema,
  ContextStoreSnapshotSchema,
  SkillCapabilityDefinitionSchema,
} from "../../../shared/contracts/index.ts";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validatePortableSkillPackage } from "@pragma/built-in-agents";
import { MAX_SKILL_PACKAGE_BYTES } from "@pragma/shared";
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
export function validateTransferredSkill(data: {
  readonly name: string;
  readonly description: string;
  readonly files: readonly TransferredSkillFile[];
}): void {
  if (
    data.files.reduce((sum, file) => sum + Buffer.from(file.content, "base64").byteLength, 0) >
    MAX_SKILL_PACKAGE_BYTES
  )
    throw new Error("Skill exceeds 25 MiB.");
  const validation = validatePortableSkillPackage(
    {
      name: data.name,
      description: data.description,
      files: data.files.map((file) => ({
        path: file.path,
        content: Buffer.from(file.content, "base64").toString("utf8"),
      })),
    },
    {
      executablePaths: new Set(
        data.files.filter((file) => file.executable).map((file) => file.path),
      ),
    },
  );
  if (!validation.passed)
    throw new Error(
      `Invalid incoming Skill: ${validation.diagnostics[0]?.message ?? "unknown error"}`,
    );
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
  if (input.current === undefined)
    return await store.publishNewSkillRevisionCandidate({
      ...common,
      name: input.name,
      description: input.description,
    });
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
  const current = (await store.list()).find((entry) => entry.id === input.storeId);
  if (current !== undefined) {
    const snapshot = await store.getSnapshot(input.storeId);
    if (
      hashSnapshotContent(snapshot.files, snapshot.directories) === input.snapshotHash &&
      (input.name === undefined || input.name === current.name) &&
      (input.description === undefined || input.description === current.description)
    )
      return current;
  }
  return await store.appendSnapshot(input, author);
}

export async function readTransferredKnowledge(store: ContextStoreStore, id: string) {
  const snapshot = await store.getSnapshot(id);
  return { snapshot, files: snapshot.files, directories: snapshot.directories };
}
