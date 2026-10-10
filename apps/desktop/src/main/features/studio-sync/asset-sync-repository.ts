import { PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID } from "@pragma/built-in-agents";
import { SemanticResourceIdSchema } from "@pragma/shared";
import { chmod, lstat, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  formatPragmaYaml,
  parsePragmaYaml,
  DEFAULT_PRAGMA_BUNDLE_LIMITS,
} from "@pragma/interpreter";
import {
  canonicalPragmaResourceRef,
  pragmaResourceDirectory,
  pragmaResourceFileName,
  PragmaForwardCompatibleResourceSchema,
  PragmaRuntimeProfileConfigSchema,
} from "@pragma/interpreter/ast";
import { z } from "zod";
import {
  CapabilityDefinitionSchema,
  CapabilityIdSchema,
  ContextStoreIdSchema,
  ContextStoreContentMetadataSchema,
  CONTEXT_STORE_FILE_MAX_BYTES,
  CoreAssetSyncItemSchema,
  WorkflowLayoutSchema,
  type CoreAssetSyncItem,
} from "../../../shared/contracts/index.ts";
import {
  bindExistingDesktopCapabilityResource,
  bindExistingDesktopContextResource,
  classifyDesktopCapabilityResource,
  classifyDesktopContextResource,
} from "../../platform/bindings/desktop-bound-resource-policy.ts";
import { isResourceItem } from "../asset-transfer/asset-transfer-service.ts";
import { KnowledgeDataSchema, SkillDataSchema } from "../asset-transfer/asset-transfer-payloads.ts";
import { fingerprint } from "../asset-transfer/asset-transfer-fingerprint.ts";
import { runAssetGit } from "../asset-git/asset-git-command.ts";
import { validateTransferredSkill } from "../asset-transfer/asset-transfer-payloads.ts";

export const SYNC_DIRECTORY = "pragma-sync";
const MAX_BYTES = 150 * 1024 * 1024;
const MarkerSchema = z
  .object({ schemaVersion: z.literal("pragma.asset-sync-repository/v1") })
  .strict();
const KnowledgeMetadataSchema = KnowledgeDataSchema.omit({ files: true })
  .extend({
    id: ContextStoreIdSchema,
    files: z.array(
      z.object({ id: z.string(), metadata: ContextStoreContentMetadataSchema }).strict(),
    ),
  })
  .strict();
const SkillMetadataSchema = SkillDataSchema.omit({ files: true })
  .extend({ id: CapabilityIdSchema, entryPath: z.literal("SKILL.md") })
  .strict();
const DefinitionSchema = z
  .object({ id: CapabilityIdSchema, definition: CapabilityDefinitionSchema })
  .strict();
const LayoutSchema = z
  .object({
    nodes: WorkflowLayoutSchema.shape.nodes,
    viewport: WorkflowLayoutSchema.shape.viewport,
  })
  .strict();
export type SyncFile = { readonly bytes: Buffer; readonly executable: boolean };
const ResourceKinds = {
  Expert: "expert",
  ExpertTeam: "team",
  Flow: "flow",
  RuntimeProfile: "runtime-profile",
  Capability: "capability",
  ContextStore: "knowledge",
} as const;
const resourceDirectories = new Set([
  "experts",
  "teams",
  "flows",
  "runtime-profiles",
  "capabilities",
  "context-stores",
]);

function safePath(path: string): void {
  if (
    path.includes("\\") ||
    [...path].some((character) => character.charCodeAt(0) < 32) ||
    path
      .split("/")
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git" ||
          /[<>:"|?*]/u.test(part) ||
          /[. ]$/u.test(part) ||
          /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(part),
      )
  )
    throw new Error(`Unsafe sync path: ${path}`);
}
function validateKnowledgeTree(
  directories: readonly string[],
  files: readonly { id: string }[],
): void {
  const seen = new Map<string, string>();
  const directoryKeys = new Set<string>();
  for (const [isDirectory, paths] of [
    [true, directories],
    [false, files.map((file) => file.id)],
  ] as const)
    for (const path of paths) {
      const parts = path.split("/");
      for (let i = 1; i <= parts.length - (isDirectory ? 0 : 1); i++)
        directoryKeys.add(parts.slice(0, i).join("/").normalize("NFKC").toLowerCase());
    }
  for (const path of [...directories, ...files.map((file) => file.id)]) {
    safePath(path);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const key = prefix.normalize("NFKC").toLowerCase();
      const previous = seen.get(key);
      if (previous !== undefined && previous !== prefix)
        throw new Error(`Non-portable Knowledge path collision: ${path}`);
      seen.set(key, prefix);
    }
  }
  for (const file of files)
    if (directoryKeys.has(file.id.normalize("NFKC").toLowerCase()))
      throw new Error(`Knowledge file/directory collision: ${file.id}`);
}
function text(bytes: Buffer): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}
function yaml(bytes: Buffer): unknown {
  return parsePragmaYaml(text(bytes));
}
function validateFiles(files: ReadonlyMap<string, SyncFile>): void {
  if (files.size > DEFAULT_PRAGMA_BUNDLE_LIMITS.maxFiles)
    throw new Error("Sync repository exceeds 20,000 files.");
  if ([...files.values()].reduce((sum, file) => sum + file.bytes.byteLength, 0) > MAX_BYTES)
    throw new Error("Sync repository exceeds 150 MiB.");
  const paths = new Set<string>();
  const prefixes = new Map<string, string>();
  for (const path of files.keys()) {
    safePath(path);
    const key = path.normalize("NFKC").toLowerCase();
    if (paths.has(key)) throw new Error(`Non-portable sync path collision: ${path}`);
    paths.add(key);
    const parts = path.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const prefix = parts.slice(0, i).join("/");
      const canonical = prefix.normalize("NFKC").toLowerCase();
      const previous = prefixes.get(canonical);
      if (previous !== undefined && previous !== prefix)
        throw new Error(`Non-portable sync directory collision: ${path}`);
      prefixes.set(canonical, prefix);
    }
  }
  for (const key of paths) {
    const parts = key.split("/");
    for (let i = 1; i < parts.length; i += 1)
      if (paths.has(parts.slice(0, i).join("/")))
        throw new Error(`Sync file/directory collision: ${key}`);
  }
}

export function encodeSyncRepository(
  items: ReadonlyMap<string, CoreAssetSyncItem>,
): Map<string, SyncFile> {
  const files = new Map<string, SyncFile>();
  const add = (path: string, bytes: Buffer, executable = false) => {
    if (files.has(path)) throw new Error(`Duplicate sync path: ${path}`);
    files.set(path, { bytes, executable });
  };
  const addYaml = (path: string, value: unknown) => add(path, Buffer.from(formatPragmaYaml(value)));
  addYaml("sync.yaml", MarkerSchema.parse({ schemaVersion: "pragma.asset-sync-repository/v1" }));
  const index: string[] = [];
  for (const item of [...items.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    let path: string;
    if (isResourceItem(item)) {
      const resource = PragmaForwardCompatibleResourceSchema.parse(item.data);
      if (resource.kind === "RuntimeProfile")
        PragmaRuntimeProfileConfigSchema.parse(resource.spec.config);
      path = `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`;
      addYaml(path, resource);
    } else {
      const id = item.key.slice(item.kind.length + 1);
      if (item.kind === "knowledge") {
        const data = KnowledgeDataSchema.parse(item.data);
        validateKnowledgeTree(data.directories, data.files);
        path = `knowledge-bases/${id}/metadata.yaml`;
        addYaml(path, {
          id,
          name: data.name,
          description: data.description,
          directories: [...data.directories].sort(),
          files: [...data.files]
            .sort((a, b) => a.id.localeCompare(b.id))
            .map(({ id, metadata }) => ({ id, metadata })),
        });
        for (const file of data.files) {
          if (Buffer.byteLength(file.content) > CONTEXT_STORE_FILE_MAX_BYTES)
            throw new Error(`Knowledge file exceeds 1 MB: ${file.id}`);
          add(`knowledge-bases/${id}/files/${file.id}`, Buffer.from(file.content));
        }
      } else if (item.kind === "skill") {
        const data = SkillDataSchema.parse(item.data);
        validateTransferredSkill(data, { id });
        path = `skills/${id}/metadata.yaml`;
        addYaml(path, {
          id,
          name: data.name,
          description: data.description,
          entryPath: "SKILL.md",
        });
        for (const file of data.files)
          add(
            `skills/${id}/files/${file.path}`,
            Buffer.from(file.content, "base64"),
            file.executable,
          );
      } else if (item.kind === "capability") {
        path = `capability-definitions/${id}.yaml`;
        addYaml(path, { id, definition: CapabilityDefinitionSchema.parse(item.data) });
      } else if (item.kind === "flow-layout") {
        path = `flow-layouts/${id}.yaml`;
        addYaml(path, LayoutSchema.parse(item.data));
      } else throw new Error(`Unsupported sync record: ${item.key}`);
    }
    const name = item.name.replaceAll("|", "\\|").replace(/[\r\n]/gu, " ");
    index.push(`| ${name} | ${item.kind} | [${path}](${path}) |`);
  }
  add(
    "README.md",
    Buffer.from(
      `# Pragma 核心资产同步\n\n定义和元数据使用 YAML，知识库与 Skill 正文保留原生文件。可直接编辑后提交到 Git，再在 Pragma 中同步。\n\n文件名使用稳定 ID；重命名只修改 YAML 中的名称。sync.yaml 声明格式版本，请保留。哈希由应用重新计算，无需手工更新。\n\n不包含密钥、运行记录、历史修订或插件安装包。Skill 可执行位以 Git index 为准。\n\n| 名称 | 类型 | 文件 |\n| --- | --- | --- |\n${index.join("\n")}\n`,
    ),
  );
  validateFiles(files);
  assertLogicalAssetLimit(items);
  return files;
}

function assertLogicalAssetLimit(items: ReadonlyMap<string, CoreAssetSyncItem>): void {
  const identities = new Set<string>();
  for (const item of items.values()) {
    if (item.kind === "flow-layout")
      identities.add(`flow:${item.key.slice("flow-layout:".length)}`);
    else if (isResourceItem(item)) {
      const resource = PragmaForwardCompatibleResourceSchema.parse(item.data);
      const binding = classifyDesktopCapabilityResource(resource);
      identities.add(
        binding
          ? items.has(`skill:${binding.id}`)
            ? `skill:${binding.id}`
            : `capability:${binding.id}`
          : canonicalPragmaResourceRef(resource),
      );
    } else identities.add(item.key);
  }
  if (identities.size > 5_000) throw new Error("Sync repository exceeds 5,000 logical assets.");
}

export function decodeSyncRepository(
  files: ReadonlyMap<string, SyncFile>,
): Map<string, CoreAssetSyncItem> {
  validateFiles(files);
  const marker = files.get("sync.yaml");
  if (!marker) throw new Error("The sync repository is missing pragma-sync/sync.yaml.");
  MarkerSchema.parse(yaml(marker.bytes));
  const consumed = new Set(["sync.yaml", "README.md"]);
  const result = new Map<string, CoreAssetSyncItem>();
  const add = (kind: CoreAssetSyncItem["kind"], id: string, name: string, data: unknown) => {
    const key = `${kind}:${id}`;
    if (result.has(key)) throw new Error(`Duplicate sync identity: ${key}`);
    result.set(
      key,
      CoreAssetSyncItemSchema.parse({ key, kind, name, data, fingerprint: fingerprint(data) }),
    );
  };
  for (const [path, file] of files) {
    const directory = path.split("/")[0]!;
    if (resourceDirectories.has(directory)) {
      const resource = PragmaForwardCompatibleResourceSchema.parse(yaml(file.bytes));
      if (
        !(resource.kind in ResourceKinds) ||
        path !== `${pragmaResourceDirectory(resource)}/${pragmaResourceFileName(resource)}`
      )
        throw new Error(`Sync resource identity does not match path: ${path}`);
      if (resource.kind === "RuntimeProfile")
        PragmaRuntimeProfileConfigSchema.parse(resource.spec.config);
      if (
        resource.kind === "Capability" &&
        classifyDesktopCapabilityResource(resource)?.id === PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID
      )
        throw new Error(`System Capability cannot be synchronized: ${path}`);
      if (resource.kind === "Capability" && !classifyDesktopCapabilityResource(resource))
        throw new Error(`Unsupported capability binding: ${path}`);
      if (resource.kind === "ContextStore" && !classifyDesktopContextResource(resource))
        throw new Error(`Unsupported context binding: ${path}`);
      add(
        ResourceKinds[resource.kind as keyof typeof ResourceKinds],
        canonicalPragmaResourceRef(resource),
        resource.metadata.name,
        resource,
      );
      consumed.add(path);
    } else if (directory === "capability-definitions") {
      const parsed = DefinitionSchema.parse(yaml(file.bytes));
      if (parsed.id === PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID)
        throw new Error(`System Capability cannot be synchronized: ${path}`);
      if (path !== `capability-definitions/${parsed.id}.yaml` || parsed.definition.kind === "skill")
        throw new Error(`Invalid capability definition: ${path}`);
      add("capability", parsed.id, parsed.definition.name, parsed.definition);
      consumed.add(path);
    } else if (directory === "flow-layouts") {
      const id = path.slice("flow-layouts/".length, -".yaml".length);
      const layout = LayoutSchema.parse(yaml(file.bytes));
      if (!SemanticResourceIdSchema.safeParse(id).success)
        throw new Error(`Invalid flow layout: ${path}`);
      add("flow-layout", id, id, layout);
      consumed.add(path);
    } else if (
      (directory === "knowledge-bases" || directory === "skills") &&
      path.endsWith("/metadata.yaml")
    ) {
      if (directory === "knowledge-bases") {
        const meta = KnowledgeMetadataSchema.parse(yaml(file.bytes));
        if (path !== `knowledge-bases/${meta.id}/metadata.yaml`)
          throw new Error(`Knowledge identity does not match path: ${path}`);
        const prefix = `knowledge-bases/${meta.id}/files/`;
        for (const path of meta.directories) safePath(path);
        for (const entry of meta.files) safePath(entry.id);
        if (new Set(meta.files.map((entry) => entry.id)).size !== meta.files.length)
          throw new Error(`Duplicate Knowledge metadata: ${path}`);
        const metadata = new Map(meta.files.map((entry) => [entry.id, entry.metadata]));
        const entries = [...files]
          .filter(([entry]) => entry.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([entry, content]) => {
            if (content.bytes.byteLength > CONTEXT_STORE_FILE_MAX_BYTES)
              throw new Error(`Knowledge file exceeds 1 MB: ${entry}`);
            consumed.add(entry);
            const id = entry.slice(prefix.length);
            return {
              id,
              content: text(content.bytes),
              metadata: metadata.get(id) ?? {
                trigger: "manual" as const,
                priority: "normal" as const,
              },
            };
          });
        const directories = new Set(meta.directories);
        for (const path of [...meta.directories, ...entries.map((entry) => entry.id)]) {
          const parts = path.split("/");
          for (let i = 1; i < parts.length; i += 1) directories.add(parts.slice(0, i).join("/"));
        }
        validateKnowledgeTree([...directories], entries);
        const data = KnowledgeDataSchema.parse({
          name: meta.name,
          description: meta.description,
          directories: [...directories].sort(),
          files: entries,
        });
        add("knowledge", meta.id, meta.name, data);
      } else {
        const meta = SkillMetadataSchema.parse(yaml(file.bytes));
        if (meta.id === PRAGMA_MANAGEMENT_DESKTOP_CAPABILITY_ID)
          throw new Error(`System Capability cannot be synchronized: ${path}`);
        if (path !== `skills/${meta.id}/metadata.yaml`)
          throw new Error(`Skill identity does not match path: ${path}`);
        const prefix = `skills/${meta.id}/files/`;
        const entries = [...files]
          .filter(([entry]) => entry.startsWith(prefix))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([entry, content]) => {
            consumed.add(entry);
            return {
              path: entry.slice(prefix.length),
              content: content.bytes.toString("base64"),
              executable: content.executable,
            };
          });
        const data = SkillDataSchema.parse({
          name: meta.name,
          description: meta.description,
          files: entries,
        });
        validateTransferredSkill(data, { id: meta.id });
        add("skill", meta.id, meta.name, data);
      }
      consumed.add(path);
    }
  }
  for (const path of files.keys())
    if (!consumed.has(path)) throw new Error(`Unexpected or orphaned sync file: ${path}`);
  for (const item of result.values())
    if (item.kind === "skill" && result.has(`capability:${item.key.slice("skill:".length)}`))
      throw new Error(`Duplicate Capability and Skill identity: ${item.key}`);
  for (const item of result.values())
    if (item.kind === "flow-layout") {
      const flow = result.get(`flow:flow:${item.key.slice("flow-layout:".length)}`);
      if (!flow) throw new Error(`Layout has no Flow: ${item.key}`);
      result.set(item.key, { ...item, name: flow.name });
    }
  for (const item of result.values()) {
    if (!isResourceItem(item)) continue;
    const resource = PragmaForwardCompatibleResourceSchema.parse(item.data);
    const binding = classifyDesktopCapabilityResource(resource);
    const storeId = classifyDesktopContextResource(resource);
    const payload = binding
      ? (result.get(`capability:${binding.id}`) ?? result.get(`skill:${binding.id}`))
      : storeId
        ? result.get(`knowledge:${storeId}`)
        : undefined;
    if (!payload) continue;
    const meta = payload.data as { name: string; description: string };
    const data = binding
      ? bindExistingDesktopCapabilityResource(
          resource as Extract<typeof resource, { kind: "Capability" }>,
          binding,
          meta,
        )
      : bindExistingDesktopContextResource(
          resource as Extract<typeof resource, { kind: "ContextStore" }>,
          storeId!,
          meta,
        );
    result.set(item.key, { ...item, name: meta.name, data, fingerprint: fingerprint(data) });
  }
  assertLogicalAssetLimit(result);
  return result;
}

export async function readSyncRepository(
  root: string,
  requireMarker: boolean,
): Promise<Map<string, CoreAssetSyncItem>> {
  const directory = join(root, SYNC_DIRECTORY);
  try {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid sync repository directory.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (requireMarker)
      throw new Error("The configured repository no longer contains pragma-sync/sync.yaml.", {
        cause: error,
      });
    return new Map();
  }
  const index = await runAssetGit(root, ["ls-files", "--stage", "-z", "--", SYNC_DIRECTORY]);
  const executablePaths = new Set(
    index
      .split("\0")
      .filter((entry) => entry.startsWith("100755 "))
      .map((entry) => entry.slice(entry.indexOf("\t") + 1).slice(SYNC_DIRECTORY.length + 1)),
  );
  const files = new Map<string, SyncFile>();
  let total = 0;
  const visit = async (path: string, relative: string) => {
    for (const entry of (await readdir(path)).sort()) {
      const child = relative ? `${relative}/${entry}` : entry;
      safePath(child);
      const target = join(path, entry);
      const info = await lstat(target);
      if (info.isSymbolicLink())
        throw new Error(`Sync repository contains a symbolic link: ${child}`);
      if (info.isDirectory()) await visit(target, child);
      else if (info.isFile()) {
        total += info.size;
        if (total > MAX_BYTES || files.size >= DEFAULT_PRAGMA_BUNDLE_LIMITS.maxFiles)
          throw new Error("Sync repository exceeds its capacity limits.");
        files.set(child, { bytes: await readFile(target), executable: executablePaths.has(child) });
      } else throw new Error(`Unsupported sync file: ${child}`);
    }
  };
  await visit(directory, "");
  return decodeSyncRepository(files);
}

export async function writeSyncRepository(
  root: string,
  items: ReadonlyMap<string, CoreAssetSyncItem>,
): Promise<void> {
  const files = encodeSyncRepository(items);
  const directory = join(root, SYNC_DIRECTORY);
  const existing: string[] = [];
  const visit = async (path: string, relative: string) => {
    for (const entry of await readdir(path)) {
      const child = relative ? `${relative}/${entry}` : entry;
      const info = await lstat(join(path, entry));
      if (info.isSymbolicLink())
        throw new Error(`Sync repository contains a symbolic link: ${child}`);
      if (info.isDirectory()) await visit(join(path, entry), child);
      else existing.push(child);
    }
  };
  try {
    await visit(directory, "");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  for (const path of existing) if (!files.has(path)) await rm(join(directory, path));
  for (const [path, file] of files) {
    const target = join(directory, path);
    await mkdir(dirname(target), { recursive: true });
    let unchanged = false;
    try {
      unchanged =
        (await readFile(target)).equals(file.bytes) &&
        Boolean((await lstat(target)).mode & 0o111) === file.executable;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!unchanged) {
      await writeFile(target, file.bytes, { mode: file.executable ? 0o700 : 0o600 });
      await chmod(target, file.executable ? 0o700 : 0o600);
    }
  }
  await runAssetGit(root, ["add", "--all", "--", SYNC_DIRECTORY]);
  for (const executable of [false, true]) {
    const paths = [...files]
      .filter(([, file]) => file.executable === executable)
      .map(([path]) => `${SYNC_DIRECTORY}/${path}`);
    for (let offset = 0; offset < paths.length; offset += 200)
      await runAssetGit(root, [
        "update-index",
        executable ? "--chmod=+x" : "--chmod=-x",
        "--",
        ...paths.slice(offset, offset + 200),
      ]);
  }
}
