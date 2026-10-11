import { FileText, Folder, FolderOpen, PencilSimple } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type { ContextStoreEntry } from "../../../../shared/contracts/index.ts";

export function AssetFileTree(props: {
  readonly entries: readonly ContextStoreEntry[];
  readonly disabled?: boolean;
  readonly selectedEntry: ContextStoreEntry | null;
  readonly collapsedDirectoryIds: ReadonlySet<string>;
  readonly onOpenEntry: (entry: ContextStoreEntry) => void;
  readonly onRenameEntry?: ((entry: ContextStoreEntry) => void) | undefined;
  readonly canRenameEntry?: (entry: ContextStoreEntry) => boolean;
  readonly canDragEntry?: (entry: ContextStoreEntry) => boolean;
  readonly draggedEntry?: ContextStoreEntry | null;
  readonly dropTargetDirectory?: string | null;
  readonly onDropTargetChange?: (directory: string | null) => void;
  readonly onDraggedEntryChange?: (entry: ContextStoreEntry | null) => void;
  readonly canMoveEntryTo?: (entry: ContextStoreEntry, directory: string) => boolean;
  readonly onMove?: ((entry: ContextStoreEntry, directory: string) => void) | undefined;
}) {
  const { t } = useTranslation("studio");
  return (
    <div
      className={
        props.dropTargetDirectory === ""
          ? "knowledge-file-tree is-root-drop-target"
          : "knowledge-file-tree"
      }
      role="tree"
      onDragOver={(event) => {
        if (props.draggedEntry == null || !props.canMoveEntryTo?.(props.draggedEntry, "")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "move";
        props.onDropTargetChange?.("");
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
          props.onDropTargetChange?.(null);
        }
      }}
      onDrop={(event) => {
        event.preventDefault();
        if (props.draggedEntry != null) props.onMove?.(props.draggedEntry, "");
      }}
    >
      {visibleAssetFileEntries(props.entries, props.collapsedDirectoryIds).map((entry) => {
        const depth = entry.id.split("/").length - 1;
        const isExpanded = entry.kind === "directory" && !props.collapsedDirectoryIds.has(entry.id);
        const Icon = entry.kind === "directory" ? (isExpanded ? FolderOpen : Folder) : FileText;
        return (
          <div
            key={`${entry.kind}:${entry.id}`}
            role="none"
            className={[
              "knowledge-file-row",
              props.selectedEntry?.id === entry.id ? "is-selected" : "",
              props.dropTargetDirectory === entry.id ? "is-drop-target" : "",
            ]
              .filter(Boolean)
              .join(" ")}
            style={{ paddingInlineStart: 12 + depth * 16 }}
            onDragOver={(event) => {
              if (
                entry.kind !== "directory" ||
                props.draggedEntry == null ||
                !props.canMoveEntryTo?.(props.draggedEntry, entry.id)
              ) {
                return;
              }
              event.preventDefault();
              event.stopPropagation();
              event.dataTransfer.dropEffect = "move";
              props.onDropTargetChange?.(entry.id);
            }}
            onDragLeave={() => {
              if (props.dropTargetDirectory === entry.id) props.onDropTargetChange?.(null);
            }}
            onDrop={(event) => {
              if (entry.kind !== "directory" || props.draggedEntry == null) return;
              event.preventDefault();
              event.stopPropagation();
              props.onMove?.(props.draggedEntry, entry.id);
            }}
          >
            <button
              className="knowledge-file-open"
              type="button"
              role="treeitem"
              aria-selected={props.selectedEntry?.id === entry.id}
              aria-expanded={entry.kind === "directory" ? isExpanded : undefined}
              disabled={props.disabled}
              draggable={
                !props.disabled &&
                props.onMove !== undefined &&
                (props.canDragEntry?.(entry) ?? true)
              }
              onClick={() => void props.onOpenEntry(entry)}
              onDragStart={(event) => {
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", entry.id);
                props.onDraggedEntryChange?.(entry);
              }}
              onDragEnd={() => {
                props.onDraggedEntryChange?.(null);
                props.onDropTargetChange?.(null);
              }}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{entry.id.split("/").at(-1)}</span>
            </button>
            {props.onRenameEntry === undefined || props.canRenameEntry?.(entry) === false ? null : (
              <button
                className="knowledge-file-rename"
                type="button"
                title={t("rename")}
                aria-label={t("renameEntryNamed", { name: entry.id.split("/").at(-1) })}
                draggable={false}
                disabled={props.disabled}
                onClick={() => void props.onRenameEntry?.(entry)}
              >
                <PencilSimple size={15} aria-hidden="true" />
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function visibleAssetFileEntries(
  entries: readonly ContextStoreEntry[],
  collapsed: ReadonlySet<string>,
): readonly ContextStoreEntry[] {
  return entries.filter((entry) => {
    const segments = entry.id.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      if (collapsed.has(segments.slice(0, depth).join("/"))) return false;
    }
    return true;
  });
}
