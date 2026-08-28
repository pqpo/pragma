import {
  ContextStoreDraftOverlaySchema,
  ContextStoreRevisionJobSchema,
  type ContextStoreDraftOverlay,
  type ContextStoreRevisionJob,
  type ContextStoreRevisionSnapshot,
} from "@pragma/built-in-agents/contracts";

import type { ContextStoreRevisionJobV1 } from "../schemas/v1.ts";

export function migrateContextStoreRevisionJobV1ToV2(
  source: ContextStoreRevisionJobV1,
  draftId: string,
): ContextStoreRevisionJob {
  return ContextStoreRevisionJobSchema.parse({
    schemaVersion: "pragma.context-store-revision-job/v2",
    id: source.id,
    revision: source.revision + 1,
    draftId,
    request: source.request,
    state: migrateState(source.state),
    ...(source.error === undefined ? {} : { error: source.error }),
    createdAt: source.createdAt,
    updatedAt: new Date().toISOString(),
  });
}

export function overlayFromV1Job(
  source: ContextStoreRevisionJobV1,
  base?: ContextStoreRevisionSnapshot,
): ContextStoreDraftOverlay {
  const files = new Map<string, ContextStoreDraftOverlay["files"][number]>();
  const deletedFiles = new Set<string>();
  for (const operation of source.changeSet?.operations ?? []) {
    if (operation.operation === "upsert") {
      files.set(operation.id, {
        id: operation.id,
        content: operation.content,
        metadata: operation.metadata,
      });
      deletedFiles.delete(operation.id);
    } else if (operation.operation === "delete") {
      files.delete(operation.id);
      deletedFiles.add(operation.id);
    } else {
      files.delete(operation.id);
      deletedFiles.add(operation.id);
      const original = base?.files.find((file) => file.id === operation.id);
      if (original !== undefined) {
        files.set(operation.nextId, { ...original, id: operation.nextId });
        deletedFiles.delete(operation.nextId);
      }
    }
  }
  return ContextStoreDraftOverlaySchema.parse({
    files: [...files.values()],
    deletedFiles: [...deletedFiles],
    directories: [],
    deletedDirectories: [],
  });
}

function migrateState(state: ContextStoreRevisionJobV1["state"]): ContextStoreRevisionJob["state"] {
  switch (state) {
    case "pending":
    case "running":
      return "editing";
    case "pending_review":
      return "pending_review";
    case "applying":
      return "merging";
    case "completed":
      return "merged";
    case "rejected":
      return "rejected";
    case "needs_attention":
    case "superseded":
      return "needs_attention";
  }
}
