import {
  ArrowClockwise,
  File,
  FilePlus,
  FileText,
  FolderPlus,
  SpinnerGap,
  TextAa,
  Trash,
} from "@phosphor-icons/react";
import { useState, type ComponentProps, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  PRAGMA_TEXT_LIMITS,
  pragmaKnowledgeBaseEntryNameIssue,
  type PragmaKnowledgeBaseEntryNameIssue,
} from "@pragma/shared";
import type { ContextStoreEntry } from "../../../../shared/contracts/index.ts";
import { SidebarResizeHandle } from "../../components/SidebarResizeHandle.tsx";
import {
  usePersistentSidebarWidth,
  type SidebarWidthPreference,
} from "../../lib/sidebar-width-preference.ts";
import { errorMessage } from "../../lib/errors.ts";
import { AssetFileEditor } from "./AssetFileEditor.tsx";
import { AssetFileTree } from "./AssetFileTree.tsx";
import {
  canMoveEntryTo,
  fileName,
  joinEntry,
  moveEntryTargetId,
  parentId,
} from "./asset-file-paths.ts";
import { StudioConfirmationDialog, StudioTextInputDialog } from "./StudioDialog.tsx";

type TextOperation = {
  kind: "create-file" | "create-folder" | "save-copy" | "rename";
  entry?: ContextStoreEntry;
  value: string;
};
type Confirmation = { kind: "delete" | "move"; entry: ContextStoreEntry; destination?: string };
export type AssetFileOperations = {
  beforeOperation?: () => Promise<boolean>;
  createFile: (path: string, copy: boolean) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  renameEntry: (entry: ContextStoreEntry, nextId: string) => Promise<void>;
  deleteEntry: (entry: ContextStoreEntry) => Promise<void>;
  canModifyEntry?: (entry: ContextStoreEntry) => boolean;
};

/** The complete file workbench; resource adapters own loading, drafts and publishing. */
export function AssetFileWorkspace(props: {
  readonly className?: string;
  readonly filesLabel: string;
  readonly resizeLabel: string;
  readonly widthPreference: SidebarWidthPreference;
  readonly entries: readonly ContextStoreEntry[];
  readonly selectedEntry: ContextStoreEntry | null;
  readonly collapsedDirectoryIds: ReadonlySet<string>;
  readonly onOpenEntry: (entry: ContextStoreEntry) => void;
  readonly loading: boolean;
  readonly onRefresh: () => Promise<void>;
  readonly operations?: AssetFileOperations | undefined;
  readonly markdownFileNames?: boolean;
  readonly editor: ComponentProps<typeof AssetFileEditor> | null;
  readonly editorChildren?: (controls: { saveCopy: () => void }) => ReactNode;
  readonly emptyEditor?: ReactNode;
  readonly emptyActions?: ReactNode;
  readonly disabled?: boolean;
  readonly deleteEntryDescription?: (entry: ContextStoreEntry) => string;
  readonly metadataPanel?: ReactNode;
}) {
  const { t } = useTranslation("studio");
  const [width, setWidth] = usePersistentSidebarWidth(props.widthPreference);
  const [operation, setOperation] = useState<TextOperation | null>(null);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragged, setDragged] = useState<ContextStoreEntry | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const operations = props.operations;
  const disabled = busy || refreshing || props.disabled === true;
  const canModify = (entry: ContextStoreEntry) =>
    operations !== undefined && (operations.canModifyEntry?.(entry) ?? true);
  const isFileOperation = (next: TextOperation) =>
    next.kind !== "create-folder" && (next.kind !== "rename" || next.entry?.kind === "file");
  const normalizeName = (next: TextOperation) => {
    const name = next.value.trim();
    return props.markdownFileNames && isFileOperation(next) && !/\.md$/iu.test(name)
      ? `${name}.md`
      : name;
  };
  const validationName = (next: TextOperation) =>
    props.markdownFileNames && isFileOperation(next)
      ? next.value.replace(/\.md$/iu, "")
      : next.value;
  const issueMessage = (issue: PragmaKnowledgeBaseEntryNameIssue) => {
    const keys = {
      empty: "entryNameRequired",
      too_long: "entryNameTooLong",
      whitespace: "entryNameWhitespaceError",
      invalid_character: "entryNameInvalidCharacterError",
      dot_name: "entryNameDotError",
      reserved_name: "entryNameReservedError",
    } as const;
    return t(keys[issue], { max: PRAGMA_TEXT_LIMITS.contextStore.entryName });
  };
  const prepare = async () =>
    operations?.beforeOperation === undefined || (await operations.beforeOperation());
  const openOperation = async (kind: TextOperation["kind"], entry?: ContextStoreEntry) => {
    if (disabled || operations === undefined) return;
    // A conflict copy preserves the current text without overwriting its source.
    if (kind !== "save-copy" && !(await prepare())) return;
    if (kind === "rename" && (entry === undefined || !canModify(entry))) return;
    setError(null);
    const name = entry === undefined ? "" : fileName(entry.id);
    setOperation({
      kind,
      ...(entry === undefined ? {} : { entry }),
      value:
        kind === "rename"
          ? props.markdownFileNames && entry?.kind === "file"
            ? name.replace(/\.md$/iu, "")
            : name
          : kind === "save-copy"
            ? "copy.md"
            : "",
    });
  };
  const label =
    operation?.kind === "create-file"
      ? t("newFile")
      : operation?.kind === "create-folder"
        ? t("newFolder")
        : operation?.kind === "rename"
          ? t("rename")
          : t("saveCopy");
  const issue =
    operation === null ? undefined : pragmaKnowledgeBaseEntryNameIssue(validationName(operation));
  const submit = async () => {
    if (operation === null || operations === undefined || busy || issue !== undefined) return;
    setBusy(true);
    setError(null);
    try {
      const directory =
        props.selectedEntry?.kind === "directory"
          ? props.selectedEntry.id
          : parentId(props.selectedEntry?.id ?? "");
      const name = normalizeName(operation);
      if (operation.kind === "rename" && operation.entry !== undefined)
        await operations.renameEntry(
          operation.entry,
          joinEntry(parentId(operation.entry.id), name),
        );
      else if (operation.kind === "create-folder")
        await operations.createFolder(joinEntry(directory, name));
      else await operations.createFile(joinEntry(directory, name), operation.kind === "save-copy");
      setOperation(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const confirm = async () => {
    if (confirmation === null || operations === undefined || busy) return;
    setBusy(true);
    setError(null);
    try {
      if (confirmation.kind === "move" && !(await prepare())) return;
      if (confirmation.kind === "delete") await operations.deleteEntry(confirmation.entry);
      else
        await operations.renameEntry(
          confirmation.entry,
          moveEntryTargetId(confirmation.entry.id, confirmation.destination ?? ""),
        );
      setConfirmation(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const canMove = (entry: ContextStoreEntry, directory: string) =>
    !disabled && canModify(entry) && canMoveEntryTo(entry, directory);
  const selectedActions =
    props.selectedEntry !== null && canModify(props.selectedEntry) ? (
      <>
        <button
          type="button"
          title={t("rename")}
          aria-label={t("rename")}
          disabled={disabled}
          onClick={() => void openOperation("rename", props.selectedEntry ?? undefined)}
        >
          <TextAa size={17} />
        </button>
        <button
          type="button"
          title={t("delete")}
          aria-label={t("delete")}
          disabled={disabled}
          onClick={() => {
            const entry = props.selectedEntry;
            if (entry !== null) {
              setError(null);
              setConfirmation({ kind: "delete", entry });
            }
          }}
        >
          <Trash size={17} />
        </button>
      </>
    ) : null;
  return (
    <>
      <div
        className={[
          "knowledge-base-workspace",
          props.metadataPanel === undefined ? "asset-file-workspace" : "",
          props.className ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        style={{ "--sidebar-width": `${width}px` } as CSSProperties}
      >
        <aside className="knowledge-file-panel" aria-label={props.filesLabel}>
          <div className="knowledge-file-toolbar">
            <div>
              {operations === undefined ? null : (
                <>
                  <button
                    type="button"
                    title={t("newFile")}
                    aria-label={t("newFile")}
                    disabled={disabled}
                    onClick={() => void openOperation("create-file")}
                  >
                    <FilePlus size={17} />
                  </button>
                  <button
                    type="button"
                    title={t("newFolder")}
                    aria-label={t("newFolder")}
                    disabled={disabled}
                    onClick={() => void openOperation("create-folder")}
                  >
                    <FolderPlus size={17} />
                  </button>
                </>
              )}
              <button
                type="button"
                title={t("refresh")}
                aria-label={t("refresh")}
                disabled={refreshing || disabled}
                onClick={() => {
                  setRefreshing(true);
                  void props
                    .onRefresh()
                    .catch((cause) => setError(errorMessage(cause)))
                    .finally(() => setRefreshing(false));
                }}
              >
                {refreshing ? (
                  <SpinnerGap className="spin" size={17} />
                ) : (
                  <ArrowClockwise size={17} />
                )}
              </button>
            </div>
          </div>
          {props.loading ? <p className="knowledge-tree-state">{t("loadingContents")}</p> : null}
          {!props.loading && props.entries.length === 0 ? (
            <div className="knowledge-tree-empty">
              <File size={23} />
              <p>{t("emptyFileWorkspace")}</p>
              {operations === undefined ? null : (
                <button type="button" onClick={() => void openOperation("create-file")}>
                  {t("createFirstFile")}
                </button>
              )}
            </div>
          ) : null}
          <AssetFileTree
            entries={props.entries}
            disabled={disabled}
            selectedEntry={props.selectedEntry}
            collapsedDirectoryIds={props.collapsedDirectoryIds}
            onOpenEntry={props.onOpenEntry}
            onRenameEntry={
              operations === undefined ? undefined : (entry) => void openOperation("rename", entry)
            }
            canRenameEntry={canModify}
            draggedEntry={dragged}
            dropTargetDirectory={dropTarget}
            onDropTargetChange={setDropTarget}
            onDraggedEntryChange={setDragged}
            canMoveEntryTo={canMove}
            canDragEntry={canModify}
            onMove={
              operations === undefined
                ? undefined
                : (entry, destination) => {
                    setDragged(null);
                    setDropTarget(null);
                    if (canMove(entry, destination)) {
                      setError(null);
                      setConfirmation({ kind: "move", entry, destination });
                    }
                  }
            }
          />
        </aside>
        <SidebarResizeHandle
          label={props.resizeLabel}
          width={width}
          preference={props.widthPreference}
          onResize={setWidth}
        />
        <section className="knowledge-editor-panel has-file-toolbar">
          {props.editor === null ? (
            <>
              <header className="knowledge-editor-toolbar">
                <div>
                  <strong>{props.selectedEntry?.id ?? ""}</strong>
                </div>
                <div>
                  {props.emptyActions}
                  {selectedActions}
                </div>
              </header>
              <div className="knowledge-editor-empty">
                {props.emptyEditor ?? (
                  <>
                    <FileText size={32} />
                    <h2>{t("selectKnowledgeFile")}</h2>
                  </>
                )}
              </div>
            </>
          ) : (
            <AssetFileEditor
              {...props.editor}
              actions={
                <>
                  {props.editor.actions}
                  {selectedActions}
                </>
              }
            >
              {props.editor.children}
              {props.editorChildren?.({ saveCopy: () => void openOperation("save-copy") })}
            </AssetFileEditor>
          )}
        </section>
        {props.metadataPanel}
      </div>
      {error !== null && operation === null && confirmation === null ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {operation === null ? null : (
        <StudioTextInputDialog
          title={label}
          description={
            operation.kind === "create-file"
              ? t(props.markdownFileNames ? "newMarkdownFilePrompt" : "newSkillFilePrompt")
              : operation.kind === "create-folder"
                ? t("newFolderPrompt")
                : operation.kind === "rename"
                  ? t("renameEntryPrompt")
                  : t("saveCopyPrompt")
          }
          label={t("entryName")}
          value={operation.value}
          hint={t("entryNameRules")}
          countValue={validationName(operation)}
          maxLength={PRAGMA_TEXT_LIMITS.contextStore.entryName}
          invalid={issue !== undefined}
          cancelLabel={t("cancel")}
          confirmLabel={label}
          busyLabel={
            operation.kind === "rename" || operation.kind === "save-copy"
              ? t("saving")
              : t("creating")
          }
          busy={busy}
          error={error ?? (issue === undefined || issue === "empty" ? null : issueMessage(issue))}
          onChange={(value) => {
            setOperation({ ...operation, value });
            setError(null);
          }}
          onCancel={() => setOperation(null)}
          onConfirm={() => void submit()}
        />
      )}
      {confirmation === null ? null : (
        <StudioConfirmationDialog
          title={t(confirmation.kind === "delete" ? "deleteEntryTitle" : "moveEntryTitle")}
          description={
            confirmation.kind === "delete"
              ? (props.deleteEntryDescription?.(confirmation.entry) ??
                t("deleteEntryConfirm", { name: confirmation.entry.id }))
              : t("moveEntryDescription", {
                  name: confirmation.entry.id,
                  destination: confirmation.destination || t("knowledgeRoot"),
                })
          }
          cancelLabel={t("cancel")}
          confirmLabel={t(confirmation.kind === "delete" ? "delete" : "moveEntryAction")}
          busyLabel={t(confirmation.kind === "delete" ? "deleting" : "movingEntry")}
          busy={busy}
          error={error}
          action={confirmation.kind}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => void confirm()}
        />
      )}
    </>
  );
}
