import type { ContextStoreEntry } from "../../../../shared/contracts/index.ts";

export function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

export function parentId(path: string): string {
  return path.split("/").slice(0, -1).join("/");
}

export function joinEntry(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function moveEntryTargetId(sourceId: string, destinationId: string): string {
  return joinEntry(destinationId, fileName(sourceId));
}

export function canMoveEntryTo(
  entry: Pick<ContextStoreEntry, "id" | "kind">,
  destinationId: string,
): boolean {
  return (
    parentId(entry.id) !== destinationId &&
    !(
      entry.kind === "directory" &&
      (destinationId === entry.id || destinationId.startsWith(`${entry.id}/`))
    )
  );
}

export function rebaseEntryId(
  currentId: string,
  sourceId: string,
  nextId: string,
): string | undefined {
  if (currentId === sourceId) return nextId;
  if (!currentId.startsWith(`${sourceId}/`)) return undefined;
  return `${nextId}${currentId.slice(sourceId.length)}`;
}
