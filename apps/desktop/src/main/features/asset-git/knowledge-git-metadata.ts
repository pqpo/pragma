import { parseDocument, stringify } from "yaml";
import { z } from "zod";

import {
  ASSET_GIT_KNOWLEDGE_METADATA_MAX_BYTES,
  ContextStoreContentMetadataSchema,
  type ContextStoreContentMetadata,
} from "../../../shared/contracts/index.ts";

export const KNOWLEDGE_METADATA_SCHEMA_VERSION = "pragma.knowledge-document-metadata/v1";
export const KNOWLEDGE_METADATA_ROOT = ".pragma/metadata/";
export const KNOWLEDGE_METADATA_MAX_BYTES = ASSET_GIT_KNOWLEDGE_METADATA_MAX_BYTES;
export const KnowledgeGitMetadataSchema = ContextStoreContentMetadataSchema.extend({
  schemaVersion: z.literal(KNOWLEDGE_METADATA_SCHEMA_VERSION),
}).strict();
const fields = ["description", "trigger", "priority", "trustLevel", "sensitivity"] as const;
export type GitFiles = Map<string, Buffer>;
export const defaultKnowledgeMetadata: ContextStoreContentMetadata = {
  trigger: "manual",
  priority: "normal",
};

export function metadataPath(documentPath: string): string {
  return `${KNOWLEDGE_METADATA_ROOT}${documentPath}.yaml`;
}

export function metadataDocumentPath(path: string): string | undefined {
  if (!path.startsWith(KNOWLEDGE_METADATA_ROOT)) return undefined;
  const documentPath = path.slice(KNOWLEDGE_METADATA_ROOT.length, -5);
  if (
    !path.endsWith(".yaml") ||
    !documentPath.toLowerCase().endsWith(".md") ||
    documentPath.includes("\\") ||
    documentPath.includes("\0") ||
    documentPath
      .split("/")
      .some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
    isKnowledgeMetadataPath(documentPath)
  )
    throw metadataError(path, "Expected a mirrored Markdown path ending in .md.yaml.");
  return documentPath;
}

export function isKnowledgeMetadataPath(path: string): boolean {
  return path === KNOWLEDGE_METADATA_ROOT.slice(0, -1) || path.startsWith(KNOWLEDGE_METADATA_ROOT);
}

function metadataError(path: string, message: string): Error {
  return Object.assign(new Error(`Invalid knowledge metadata at ${path}: ${message}`), {
    code: "asset_git_metadata_invalid",
    path,
  });
}

export function decodeMetadata(path: string, bytes: Buffer): ContextStoreContentMetadata {
  try {
    if (bytes.byteLength > KNOWLEDGE_METADATA_MAX_BYTES) throw new Error("YAML exceeds 64 KiB.");
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const document = parseDocument(text, { uniqueKeys: true });
    const diagnostics = [...document.errors, ...document.warnings];
    if (diagnostics.length) throw new Error(diagnostics.map((error) => error.message).join("; "));
    const value = KnowledgeGitMetadataSchema.parse(document.toJS({ maxAliasCount: 0 }));
    return ContextStoreContentMetadataSchema.parse(value);
  } catch (error) {
    throw metadataError(path, error instanceof Error ? error.message : String(error));
  }
}

export function encodeMetadata(metadata: ContextStoreContentMetadata): Buffer {
  const validated = ContextStoreContentMetadataSchema.parse(metadata);
  const value: Record<string, string> = { schemaVersion: KNOWLEDGE_METADATA_SCHEMA_VERSION };
  for (const field of fields) {
    const entry = validated[field];
    if (entry !== undefined) value[field] = entry;
  }
  return Buffer.from(stringify(value, { lineWidth: 0 }));
}

export function markdownFiles(files: GitFiles): GitFiles {
  return new Map([...files].filter(([path]) => !isKnowledgeMetadataPath(path)));
}

/** Validate actual sidecars before synthesizing missing ones. Never discard orphan data. */
export function normalizeKnowledgeFiles(files: GitFiles, fallback: GitFiles = new Map()): GitFiles {
  const normalized = new Map(files);
  for (const [path, bytes] of files) {
    if (!isKnowledgeMetadataPath(path)) continue;
    const documentPath = metadataDocumentPath(path);
    if (!documentPath || !files.has(documentPath))
      throw metadataError(path, "The corresponding Markdown document does not exist.");
    normalized.set(path, encodeMetadata(decodeMetadata(path, bytes)));
  }
  for (const path of markdownFiles(files).keys()) {
    const sidecar = metadataPath(path);
    if (!normalized.has(sidecar))
      normalized.set(sidecar, fallback.get(sidecar) ?? encodeMetadata(defaultKnowledgeMetadata));
  }
  return normalized;
}

export function mergeMetadata(
  path: string,
  base: Buffer | undefined,
  local: Buffer,
  remote: Buffer,
): { local: Buffer; remote: Buffer; conflict: boolean } {
  const old = base ? decodeMetadata(path, base) : undefined;
  const ours = decodeMetadata(path, local);
  const theirs = decodeMetadata(path, remote);
  const favorLocal: Record<string, unknown> = {};
  const favorRemote: Record<string, unknown> = {};
  let conflict = false;
  for (const field of fields) {
    const a = ours[field],
      b = theirs[field],
      previous = old?.[field];
    if (a === b || (old !== undefined && b === previous)) {
      favorLocal[field] = favorRemote[field] = a;
    } else if (old !== undefined && a === previous) {
      favorLocal[field] = favorRemote[field] = b;
    } else {
      conflict = true;
      favorLocal[field] = a;
      favorRemote[field] = b;
    }
  }
  return {
    local: encodeMetadata(ContextStoreContentMetadataSchema.parse(favorLocal)),
    remote: encodeMetadata(ContextStoreContentMetadataSchema.parse(favorRemote)),
    conflict,
  };
}

export async function mergeKnowledgeFiles(
  base: GitFiles,
  local: GitFiles,
  remote: GitFiles,
  hasMetadataBaseline: boolean,
  mergeMarkdown: (
    base: GitFiles,
    local: GitFiles,
    remote: GitFiles,
  ) => Promise<{ files: GitFiles; conflicts: string[] }>,
) {
  const merged = await mergeMarkdown(
    markdownFiles(base),
    markdownFiles(local),
    markdownFiles(remote),
  );
  const metadataPreviews = new Map<string, ReturnType<typeof mergeMetadata>>();
  const documentConflicts = new Set<string>();
  for (const path of new Set([
    ...markdownFiles(base).keys(),
    ...markdownFiles(local).keys(),
    ...markdownFiles(remote).keys(),
  ])) {
    const sidecar = metadataPath(path);
    const old = base.get(sidecar),
      ours = local.get(sidecar),
      theirs = remote.get(sidecar);
    if (base.has(path) && local.has(path) !== remote.has(path)) {
      const surviving = local.has(path) ? ours : theirs;
      if (old && surviving && !old.equals(surviving)) {
        merged.conflicts.push(path);
        documentConflicts.add(path);
      }
    }
    if (!local.has(path) || !remote.has(path)) {
      if (merged.files.has(path) || merged.conflicts.includes(path)) {
        const metadata = local.has(path) ? ours : theirs;
        if (metadata) merged.files.set(sidecar, metadata);
      }
      continue;
    }
    const preview = mergeMetadata(sidecar, hasMetadataBaseline ? old : undefined, ours!, theirs!);
    metadataPreviews.set(sidecar, preview);
    if (preview.conflict) merged.conflicts.push(sidecar);
    else merged.files.set(sidecar, preview.local);
  }
  // Body deletion conflicts also own the metadata choice, even if content changed as well.
  for (const path of merged.conflicts) {
    if (!isKnowledgeMetadataPath(path) && local.has(path) !== remote.has(path))
      documentConflicts.add(path);
  }
  return { ...merged, metadataPreviews, documentConflicts };
}
