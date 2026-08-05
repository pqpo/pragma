import {
  ArrowLeft,
  ArrowClockwise,
  CaretRight,
  Check,
  Database,
  Eye,
  File,
  FilePlus,
  FileText,
  Folder,
  FolderPlus,
  MagnifyingGlass,
  PencilSimple,
  Plus,
  SpinnerGap,
  TextAa,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import {
  PRAGMA_TEXT_LIMITS,
  pragmaKnowledgeBaseEntryNameIssue,
  truncatePragmaTrimmedUnicode,
  type PragmaKnowledgeBaseEntryNameIssue,
} from "@pragma/shared";

import type {
  ContextStore,
  ContextStoreContent,
  ContextStoreContentMetadata,
  ContextStoreEntry,
  ContextStoreImportInspection,
  CreateContextStore,
  ExpertContextStoreMount,
} from "../../../../shared/contracts/index.ts";
import { CharacterCount } from "../../components/CharacterCount.tsx";
import { MarkdownContent } from "../../components/MarkdownContent.tsx";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { SidebarResizeHandle } from "../../components/SidebarResizeHandle.tsx";
import { errorMessage } from "../../lib/errors.ts";
import {
  SIDEBAR_WIDTH_PREFERENCES,
  usePersistentSidebarWidth,
} from "../../lib/sidebar-width-preference.ts";
import {
  flushContextStoreSaves,
  type ContextStoreSaveCoordinator,
} from "./context-store-autosave.ts";
import { StudioConfirmationDialog, StudioTextInputDialog } from "./StudioDialog.tsx";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";

type CreateStep = "intro" | "configure" | "review";
type CreateMode = CreateContextStore["mode"];
type SaveStatus = "idle" | "saving" | "saved" | "error";
type EntryTextOperation =
  | {
      readonly kind: "create-file" | "create-folder" | "save-copy";
      readonly value: string;
      readonly busy: boolean;
      readonly error: string | null;
    }
  | {
      readonly kind: "rename";
      readonly entry: ContextStoreEntry;
      readonly value: string;
      readonly busy: boolean;
      readonly error: string | null;
    };
type EntryConfirmation =
  | { readonly kind: "delete"; readonly entry: ContextStoreEntry }
  | {
      readonly kind: "move";
      readonly entry: ContextStoreEntry;
      readonly destinationId: string;
      readonly nextId: string;
    };
type EditorStateSnapshot = {
  readonly selectedEntry: ContextStoreEntry | null;
  readonly content: ContextStoreContent | null;
  readonly draft: string;
  readonly metadata: ContextStoreContentMetadata;
  readonly dirty: boolean;
  readonly editVersion: number;
  readonly documentVersion: number;
};

const DEFAULT_METADATA: ContextStoreContentMetadata = {
  trigger: "manual",
  priority: "normal",
};

function fileName(path: string): string {
  return path.split(/[\\/]/).at(-1) ?? path;
}

function parentId(path: string): string {
  const parts = path.split("/");
  parts.pop();
  return parts.join("/");
}

function joinEntry(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

export function moveEntryTargetId(sourceId: string, destinationId: string): string {
  return joinEntry(destinationId, fileName(sourceId));
}

export function canMoveEntryTo(
  entry: Pick<ContextStoreEntry, "id" | "kind">,
  destinationId: string,
): boolean {
  if (parentId(entry.id) === destinationId) return false;
  if (
    entry.kind === "directory" &&
    (destinationId === entry.id || destinationId.startsWith(`${entry.id}/`))
  ) {
    return false;
  }
  return moveEntryTargetId(entry.id, destinationId) !== entry.id;
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

function withMarkdownExtension(value: string): string {
  const trimmed = value.trim();
  return trimmed.toLowerCase().endsWith(".md") ? trimmed : `${trimmed}.md`;
}

function entryOperationName(operation: EntryTextOperation, value = operation.value): string {
  const isFile =
    operation.kind === "create-file" ||
    operation.kind === "save-copy" ||
    (operation.kind === "rename" && operation.entry.kind === "file");
  return isFile ? value.replace(/\.md$/iu, "") : value;
}

export function ContextStoreDirectoryFragment(props: {
  readonly stores: readonly ContextStore[];
  readonly onCreate: (input: CreateContextStore) => Promise<ContextStore>;
  readonly onInspectImport: (sourcePath: string) => Promise<ContextStoreImportInspection>;
  readonly onPickFolder: () => Promise<string | undefined>;
  readonly onOpen: (store: ContextStore) => void;
}) {
  const { t } = useTranslation("studio");
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const stores = useMemo(
    () =>
      props.stores.filter((store) =>
        `${store.name} ${store.description}`.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [props.stores, query],
  );

  return (
    <StudioScreenFrame
      className="context-store-directory"
      labelledBy="context-stores-heading"
      header={
        <header className="studio-heading expert-directory-heading">
          <div>
            <h1 id="context-stores-heading">{t("knowledgeBases")}</h1>
            <p>{t("knowledgeBasesDescription")}</p>
          </div>
          <button className="primary-button" type="button" onClick={() => setCreating(true)}>
            <Plus size={17} aria-hidden="true" />
            {t("createKnowledgeBase")}
          </button>
        </header>
      }
    >
      <label className="directory-search store-search">
        <MagnifyingGlass size={18} aria-hidden="true" />
        <span className="sr-only">{t("searchKnowledgeBases")}</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchKnowledgeBases")}
        />
      </label>

      {stores.length === 0 ? (
        <div className="empty-state store-empty-state">
          <Database size={28} aria-hidden="true" />
          <h3>{props.stores.length === 0 ? t("noKnowledgeBases") : t("noMatchingStores")}</h3>
          <p>
            {props.stores.length === 0 ? t("createKnowledgeBaseDescription") : t("trySearchFilter")}
          </p>
          {props.stores.length === 0 ? (
            <button className="primary-button" type="button" onClick={() => setCreating(true)}>
              {t("createKnowledgeBase")}
            </button>
          ) : null}
        </div>
      ) : (
        <div className="store-table" role="list" aria-label={t("knowledgeBases")}>
          <div className="store-table-heading" aria-hidden="true">
            <span className="store-column-name">{t("knowledgeBase")}</span>
            <span className="store-column-type">{t("format")}</span>
            <span className="store-column-source">{t("source")}</span>
            <span className="store-column-status">{t("status")}</span>
            <span className="store-column-action" />
          </div>
          {stores.map((store) => (
            <button
              className="store-list-row"
              key={store.id}
              type="button"
              onClick={() => props.onOpen(store)}
            >
              <span className="store-list-name store-column-name">
                <span className="store-icon" aria-hidden="true">
                  <Folder size={22} />
                </span>
                <span>
                  <strong>{store.name}</strong>
                  <small>{store.description || t("noDescription")}</small>
                </span>
              </span>
              <span className="store-column-type">Markdown</span>
              <span className="store-source store-column-source">
                {store.source.origin === "created"
                  ? t("createdKnowledgeBase")
                  : store.source.origin === "copied"
                    ? t("copiedKnowledgeBase")
                    : t("migratedKnowledgeBase")}
              </span>
              <span className="store-status store-column-status">
                <i className={store.status === "ready" ? "is-ready" : ""} />
                {store.status === "ready" ? t("ready") : t("needsAttention")}
              </span>
              <CaretRight className="store-column-action" size={17} aria-hidden="true" />
            </button>
          ))}
          <p className="directory-count">{t("knowledgeBaseCount", { count: stores.length })}</p>
        </div>
      )}

      {creating ? (
        <ContextStoreCreatorDrawer
          onClose={() => setCreating(false)}
          onCreate={props.onCreate}
          onInspectImport={props.onInspectImport}
          onPickFolder={props.onPickFolder}
          onCreated={(store) => {
            setCreating(false);
            props.onOpen(store);
          }}
        />
      ) : null}
    </StudioScreenFrame>
  );
}

export function ContextStoreDetailFragment(props: {
  readonly store: ContextStore;
  readonly onBack: () => void;
  readonly onOpenRevisions?: (() => void) | undefined;
  readonly onDelete: () => Promise<void>;
  readonly onListEntries: (storeId: string) => Promise<readonly ContextStoreEntry[]>;
  readonly onGetContent: (storeId: string, contentId: string) => Promise<ContextStoreContent>;
  readonly onCreateFile: (
    storeId: string,
    id: string,
    content: string,
    metadata: ContextStoreContentMetadata,
  ) => Promise<ContextStoreContent>;
  readonly onCreateFolder: (storeId: string, id: string) => Promise<void>;
  readonly onUpdateFile: (
    storeId: string,
    id: string,
    content: string,
    metadata: ContextStoreContentMetadata,
    expectedRevision: string,
  ) => Promise<ContextStoreContent>;
  readonly onRenameEntry: (
    storeId: string,
    id: string,
    nextId: string,
    kind: "file" | "directory",
  ) => Promise<void>;
  readonly onDeleteEntry: (
    storeId: string,
    id: string,
    kind: "file" | "directory",
  ) => Promise<void>;
  readonly onSubscribe: (storeId: string, listener: () => void) => () => void;
}) {
  const { t } = useTranslation("studio");
  const [entries, setEntries] = useState<readonly ContextStoreEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<ContextStoreEntry | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState("");
  const [content, setContent] = useState<ContextStoreContent | null>(null);
  const [draft, setDraft] = useState("");
  const [metadata, setMetadata] = useState<ContextStoreContentMetadata>(DEFAULT_METADATA);
  const [dirty, setDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [entryTextOperation, setEntryTextOperation] = useState<EntryTextOperation | null>(null);
  const [entryConfirmation, setEntryConfirmation] = useState<EntryConfirmation | null>(null);
  const [entryConfirmationBusy, setEntryConfirmationBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [draggedEntry, setDraggedEntry] = useState<ContextStoreEntry | null>(null);
  const [dropTargetDirectory, setDropTargetDirectory] = useState<string | null>(null);
  const [filePanelWidth, setFilePanelWidth] = usePersistentSidebarWidth(
    SIDEBAR_WIDTH_PREFERENCES.knowledgeBaseFiles,
  );
  const [autosaveVersion, setAutosaveVersion] = useState(0);
  const editVersionRef = useRef(0);
  const documentVersionRef = useRef(0);
  const loadRequestRef = useRef(0);
  const saveCoordinatorRef = useRef<ContextStoreSaveCoordinator>({ inFlight: null });
  const currentRef = useRef<EditorStateSnapshot>({
    selectedEntry: null,
    content: null,
    draft: "",
    metadata: DEFAULT_METADATA,
    dirty: false,
    editVersion: 0,
    documentVersion: 0,
  });
  currentRef.current = {
    selectedEntry,
    content,
    draft,
    metadata,
    dirty,
    editVersion: editVersionRef.current,
    documentVersion: documentVersionRef.current,
  };

  const markEdited = useCallback(
    (change: Pick<Partial<EditorStateSnapshot>, "draft" | "metadata">) => {
      const editVersion = editVersionRef.current + 1;
      editVersionRef.current = editVersion;
      currentRef.current = {
        ...currentRef.current,
        ...change,
        dirty: true,
        editVersion,
      };
      setDirty(true);
      setAutosaveVersion(editVersion);
      setSaveStatus("idle");
    },
    [],
  );

  const loadEntries = useCallback(
    async (expectedSelection?: ContextStoreEntry | null) => {
      try {
        const next = await props.onListEntries(props.store.id);
        setEntries(next);
        const current =
          expectedSelection === undefined ? currentRef.current.selectedEntry : expectedSelection;
        if (
          current !== null &&
          !next.some((entry) => entry.id === current.id && entry.kind === current.kind)
        ) {
          setSelectedEntry(null);
          setSelectedDirectory("");
          setContent(null);
          setDraft("");
          setDirty(false);
        }
        setError(null);
      } catch (cause) {
        setError(errorMessage(cause));
      } finally {
        setLoading(false);
      }
    },
    [props.onListEntries, props.store.id],
  );

  const loadFile = useCallback(
    async (entry: ContextStoreEntry, discardChanges = false) => {
      const request = loadRequestRef.current + 1;
      loadRequestRef.current = request;
      const editVersionAtStart = editVersionRef.current;
      try {
        const loaded = await props.onGetContent(props.store.id, entry.id);
        if (loadRequestRef.current !== request) return;
        if (
          !discardChanges &&
          currentRef.current.dirty &&
          editVersionRef.current !== editVersionAtStart
        ) {
          setConflict(true);
          return;
        }
        documentVersionRef.current += 1;
        const nextState: EditorStateSnapshot = {
          selectedEntry: entry,
          content: loaded,
          draft: loaded.content,
          metadata: loaded.metadata,
          dirty: false,
          editVersion: editVersionRef.current,
          documentVersion: documentVersionRef.current,
        };
        currentRef.current = nextState;
        setSelectedEntry(entry);
        setSelectedDirectory(parentId(entry.id));
        setContent(loaded);
        setDraft(loaded.content);
        setMetadata(loaded.metadata);
        setDirty(false);
        setConflict(false);
        setSaveStatus("idle");
        setPreview(true);
        setError(null);
      } catch (cause) {
        setError(errorMessage(cause));
      }
    },
    [props.onGetContent, props.store.id],
  );

  const save = useCallback(
    async (): Promise<boolean> =>
      await flushContextStoreSaves(saveCoordinatorRef.current, {
        read: () => {
          const snapshot = currentRef.current;
          if (
            !snapshot.dirty ||
            snapshot.selectedEntry?.kind !== "file" ||
            snapshot.content?.revision === undefined
          ) {
            return undefined;
          }
          return {
            entryId: snapshot.selectedEntry.id,
            revision: snapshot.content.revision,
            draft: snapshot.draft,
            metadata: snapshot.metadata,
            editVersion: snapshot.editVersion,
            documentVersion: snapshot.documentVersion,
          };
        },
        persist: async (snapshot) => {
          setSaveStatus("saving");
          return await props.onUpdateFile(
            props.store.id,
            snapshot.entryId,
            snapshot.draft,
            snapshot.metadata,
            snapshot.revision,
          );
        },
        onSaved: (snapshot, saved) => {
          const latest = currentRef.current;
          if (
            latest.documentVersion !== snapshot.documentVersion ||
            latest.selectedEntry?.id !== snapshot.entryId
          ) {
            return;
          }
          const hasNewerChanges = latest.editVersion !== snapshot.editVersion;
          currentRef.current = {
            ...latest,
            content: saved,
            dirty: hasNewerChanges,
          };
          setContent(saved);
          setDirty(hasNewerChanges);
          setConflict(false);
          setSaveStatus(hasNewerChanges ? "idle" : "saved");
          setError(null);
        },
        onFailed: (snapshot, cause) => {
          const latest = currentRef.current;
          if (
            latest.documentVersion === snapshot.documentVersion &&
            latest.selectedEntry?.id === snapshot.entryId
          ) {
            const message = errorMessage(cause);
            setSaveStatus("error");
            setError(message);
            if (/revision|conflict/i.test(message)) setConflict(true);
          }
        },
      }),
    [props.onUpdateFile, props.store.id],
  );

  useEffect(() => {
    setLoading(true);
    void loadEntries();
    return props.onSubscribe(props.store.id, () => {
      void loadEntries();
      const current = currentRef.current;
      if (current.selectedEntry?.kind !== "file") return;
      if (current.dirty || saveCoordinatorRef.current.inFlight !== null) {
        setConflict(true);
        return;
      }
      void loadFile(current.selectedEntry);
    });
  }, [loadEntries, loadFile, props.onSubscribe, props.store.id]);

  useEffect(() => {
    if (!dirty) return;
    const timeout = window.setTimeout(() => void save(), 500);
    return () => window.clearTimeout(timeout);
  }, [autosaveVersion, dirty, save]);

  const openEntry = async (entry: ContextStoreEntry) => {
    if (entry.kind === "directory") {
      if (await save()) {
        setSelectedEntry(entry);
        setSelectedDirectory(entry.id);
        setContent(null);
      }
      return;
    }
    if (selectedEntry?.id === entry.id) return;
    if (await save()) await loadFile(entry);
  };

  const openEntryTextOperation = async (
    operation: EntryTextOperation["kind"],
    targetEntry?: ContextStoreEntry,
  ): Promise<void> => {
    if (!(await save())) return;
    if (operation === "rename") {
      const entry = targetEntry ?? selectedEntry;
      if (entry === null) return;
      setEntryTextOperation({
        kind: "rename",
        entry,
        value:
          entry.kind === "file" ? fileName(entry.id).replace(/\.md$/iu, "") : fileName(entry.id),
        busy: false,
        error: null,
      });
      return;
    }
    setEntryTextOperation({
      kind: operation,
      value: operation === "save-copy" ? "copy.md" : "",
      busy: false,
      error: null,
    });
  };

  const submitEntryTextOperation = async (): Promise<void> => {
    const operation = entryTextOperation;
    if (operation === null || operation.busy || operation.value.trim() === "") return;
    const validationIssue = pragmaKnowledgeBaseEntryNameIssue(entryOperationName(operation));
    if (validationIssue !== undefined) {
      setEntryTextOperation({
        ...operation,
        error: entryNameIssueMessage(validationIssue),
      });
      return;
    }
    setEntryTextOperation({ ...operation, busy: true, error: null });
    try {
      if (operation.kind === "create-folder") {
        await props.onCreateFolder(
          props.store.id,
          joinEntry(selectedDirectory, operation.value.trim()),
        );
        await loadEntries();
      } else if (operation.kind === "rename") {
        const nextName =
          operation.entry.kind === "file"
            ? withMarkdownExtension(operation.value)
            : operation.value.trim();
        const nextId = joinEntry(parentId(operation.entry.id), nextName);
        const currentSelection = currentRef.current.selectedEntry;
        await props.onRenameEntry(props.store.id, operation.entry.id, nextId, operation.entry.kind);
        const rebasedId =
          currentSelection === null
            ? undefined
            : rebaseEntryId(currentSelection.id, operation.entry.id, nextId);
        const nextSelection =
          currentSelection !== null && rebasedId !== undefined
            ? { ...currentSelection, id: rebasedId }
            : currentSelection;
        if (nextSelection !== null && rebasedId !== undefined) {
          setSelectedEntry(nextSelection);
          setSelectedDirectory(
            nextSelection.kind === "directory" ? nextSelection.id : parentId(nextSelection.id),
          );
          if (nextSelection.kind === "directory") {
            setContent(null);
            setDraft("");
            setDirty(false);
          }
        }
        await loadEntries(nextSelection);
        if (nextSelection?.kind === "file" && rebasedId !== undefined) {
          await loadFile(nextSelection, true);
        }
      } else {
        const id = joinEntry(selectedDirectory, withMarkdownExtension(operation.value));
        const created = await props.onCreateFile(
          props.store.id,
          id,
          operation.kind === "save-copy" ? draft : "",
          operation.kind === "save-copy"
            ? metadata
            : {
                ...DEFAULT_METADATA,
                description: fileName(id).replace(/\.md$/i, ""),
              },
        );
        await loadEntries();
        await loadFile({ id, kind: "file", revision: created.revision });
      }
      setEntryTextOperation(null);
      setError(null);
    } catch (cause) {
      setEntryTextOperation({ ...operation, busy: false, error: errorMessage(cause) });
    }
  };

  const refreshEntries = async (): Promise<void> => {
    if (refreshing) return;
    setRefreshing(true);
    await loadEntries();
    setRefreshing(false);
  };

  const proposeMove = (entry: ContextStoreEntry, destinationId: string): void => {
    setDraggedEntry(null);
    setDropTargetDirectory(null);
    if (!canMoveEntryTo(entry, destinationId)) return;
    setEntryConfirmation({
      kind: "move",
      entry,
      destinationId,
      nextId: moveEntryTargetId(entry.id, destinationId),
    });
  };

  const confirmEntryOperation = async (): Promise<void> => {
    const operation = entryConfirmation;
    if (operation === null || entryConfirmationBusy) return;
    setEntryConfirmationBusy(true);
    try {
      let expectedSelection: ContextStoreEntry | null | undefined;
      if (operation.kind === "delete") {
        await props.onDeleteEntry(props.store.id, operation.entry.id, operation.entry.kind);
        const selectedId = currentRef.current.selectedEntry?.id;
        if (
          selectedId === operation.entry.id ||
          selectedId?.startsWith(`${operation.entry.id}/`) === true
        ) {
          setSelectedEntry(null);
          setSelectedDirectory("");
          setContent(null);
          setDraft("");
          setDirty(false);
          expectedSelection = null;
        }
      } else {
        if (!(await save())) return;
        await props.onRenameEntry(
          props.store.id,
          operation.entry.id,
          operation.nextId,
          operation.entry.kind,
        );
        const selected = currentRef.current.selectedEntry;
        const rebasedId =
          selected === null
            ? undefined
            : rebaseEntryId(selected.id, operation.entry.id, operation.nextId);
        if (selected !== null && rebasedId !== undefined) {
          const rebased = { ...selected, id: rebasedId };
          expectedSelection = rebased;
          setSelectedEntry(rebased);
          setSelectedDirectory(selected.kind === "directory" ? rebasedId : parentId(rebasedId));
          if (selected.kind === "file") await loadFile(rebased, true);
        }
      }
      await loadEntries(expectedSelection);
      setEntryConfirmation(null);
      setError(null);
    } catch (cause) {
      setEntryConfirmation(null);
      setError(errorMessage(cause));
    } finally {
      setEntryConfirmationBusy(false);
    }
  };

  const removeStore = async () => {
    setDeleting(true);
    try {
      await props.onDelete();
    } catch (cause) {
      setError(errorMessage(cause));
      setConfirmOpen(false);
    } finally {
      setDeleting(false);
    }
  };

  const entryNameIssueMessage = (issue: PragmaKnowledgeBaseEntryNameIssue): string => {
    switch (issue) {
      case "empty":
        return t("entryNameRequired");
      case "too_long":
        return t("entryNameTooLong", { max: PRAGMA_TEXT_LIMITS.contextStore.entryName });
      case "whitespace":
        return t("entryNameWhitespaceError");
      case "invalid_character":
        return t("entryNameInvalidCharacterError");
      case "dot_name":
        return t("entryNameDotError");
      case "reserved_name":
        return t("entryNameReservedError");
    }
  };

  const entryNameIssue =
    entryTextOperation === null
      ? undefined
      : pragmaKnowledgeBaseEntryNameIssue(entryOperationName(entryTextOperation));

  return (
    <StudioScreenFrame
      className="knowledge-base-editor"
      labelledBy="context-store-name"
      header={
        <div className="knowledge-base-editor-header">
          <button
            className="back-link"
            type="button"
            onClick={() => void save().then((saved) => saved && props.onBack())}
          >
            <ArrowLeft size={18} aria-hidden="true" />
            {t("backKnowledgeBases")}
          </button>
          <div className="knowledge-base-title">
            <Folder size={24} aria-hidden="true" />
            <div>
              <h1 id="context-store-name">{props.store.name}</h1>
              <p>{props.store.description || t("noDescription")}</p>
            </div>
          </div>
          <button className="danger-button" type="button" onClick={() => setConfirmOpen(true)}>
            <Trash size={17} aria-hidden="true" />
            {t("deleteKnowledgeBaseAction")}
          </button>
          {props.onOpenRevisions !== undefined ? (
            <button type="button" onClick={props.onOpenRevisions}>
              <ArrowClockwise size={17} aria-hidden="true" />
              {t("viewStoreRevisions")}
            </button>
          ) : null}
        </div>
      }
    >
      <div
        className="knowledge-base-workspace"
        style={{ "--sidebar-width": `${filePanelWidth}px` } as CSSProperties}
      >
        <aside className="knowledge-file-panel" aria-label={t("knowledgeBaseFiles")}>
          <div className="knowledge-file-toolbar">
            <div>
              <button
                type="button"
                title={t("newFile")}
                aria-label={t("newFile")}
                onClick={() => void openEntryTextOperation("create-file")}
              >
                <FilePlus size={17} />
              </button>
              <button
                type="button"
                title={t("newFolder")}
                aria-label={t("newFolder")}
                onClick={() => void openEntryTextOperation("create-folder")}
              >
                <FolderPlus size={17} />
              </button>
              <button
                type="button"
                title={t("refresh")}
                aria-label={t("refresh")}
                disabled={refreshing}
                onClick={() => void refreshEntries()}
              >
                {refreshing ? (
                  <SpinnerGap className="spin" size={17} />
                ) : (
                  <ArrowClockwise size={17} />
                )}
              </button>
            </div>
          </div>
          {loading ? <p className="knowledge-tree-state">{t("loadingContents")}</p> : null}
          {!loading && entries.length === 0 ? (
            <div className="knowledge-tree-empty">
              <File size={23} />
              <p>{t("emptyKnowledgeBase")}</p>
              <button type="button" onClick={() => void openEntryTextOperation("create-file")}>
                {t("createFirstFile")}
              </button>
            </div>
          ) : null}
          <div
            className={
              dropTargetDirectory === ""
                ? "knowledge-file-tree is-root-drop-target"
                : "knowledge-file-tree"
            }
            role="tree"
            onDragOver={(event) => {
              if (draggedEntry === null || !canMoveEntryTo(draggedEntry, "")) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = "move";
              setDropTargetDirectory("");
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                setDropTargetDirectory(null);
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              if (draggedEntry !== null) proposeMove(draggedEntry, "");
            }}
          >
            {entries.map((entry) => {
              const depth = entry.id.split("/").length - 1;
              const Icon = entry.kind === "directory" ? Folder : FileText;
              return (
                <div
                  key={`${entry.kind}:${entry.id}`}
                  role="none"
                  className={[
                    "knowledge-file-row",
                    selectedEntry?.id === entry.id ? "is-selected" : "",
                    dropTargetDirectory === entry.id ? "is-drop-target" : "",
                  ]
                    .filter(Boolean)
                    .join(" ")}
                  style={{ paddingInlineStart: 12 + depth * 18 }}
                  onDragOver={(event) => {
                    if (
                      entry.kind !== "directory" ||
                      draggedEntry === null ||
                      !canMoveEntryTo(draggedEntry, entry.id)
                    ) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    event.dataTransfer.dropEffect = "move";
                    setDropTargetDirectory(entry.id);
                  }}
                  onDragLeave={() => {
                    if (dropTargetDirectory === entry.id) setDropTargetDirectory(null);
                  }}
                  onDrop={(event) => {
                    if (entry.kind !== "directory" || draggedEntry === null) return;
                    event.preventDefault();
                    event.stopPropagation();
                    proposeMove(draggedEntry, entry.id);
                  }}
                >
                  <button
                    className="knowledge-file-open"
                    type="button"
                    role="treeitem"
                    aria-selected={selectedEntry?.id === entry.id}
                    draggable
                    onClick={() => void openEntry(entry)}
                    onDragStart={(event) => {
                      event.dataTransfer.effectAllowed = "move";
                      event.dataTransfer.setData("text/plain", entry.id);
                      setDraggedEntry(entry);
                    }}
                    onDragEnd={() => {
                      setDraggedEntry(null);
                      setDropTargetDirectory(null);
                    }}
                  >
                    <Icon size={17} aria-hidden="true" />
                    <span>{fileName(entry.id)}</span>
                  </button>
                  <button
                    className="knowledge-file-rename"
                    type="button"
                    title={t("rename")}
                    aria-label={t("renameEntryNamed", { name: fileName(entry.id) })}
                    draggable={false}
                    onClick={() => void openEntryTextOperation("rename", entry)}
                  >
                    <PencilSimple size={15} aria-hidden="true" />
                  </button>
                </div>
              );
            })}
          </div>
        </aside>
        <SidebarResizeHandle
          label={t("resizeKnowledgeFileList")}
          width={filePanelWidth}
          preference={SIDEBAR_WIDTH_PREFERENCES.knowledgeBaseFiles}
          onResize={setFilePanelWidth}
        />

        <section className="knowledge-editor-panel">
          {selectedEntry?.kind === "file" && content !== null ? (
            <>
              <header className="knowledge-editor-toolbar">
                <div>
                  <strong>{selectedEntry.id}</strong>
                  <span className={`knowledge-save-status is-${saveStatus}`}>
                    {saveStatus === "saving"
                      ? t("saving")
                      : saveStatus === "saved"
                        ? t("saved")
                        : saveStatus === "error"
                          ? t("saveFailed")
                          : ""}
                  </span>
                </div>
                <div>
                  <button
                    className={!preview ? "is-active" : ""}
                    type="button"
                    title={t("edit")}
                    aria-label={t("edit")}
                    onClick={() => setPreview(false)}
                  >
                    <PencilSimple size={17} />
                  </button>
                  <button
                    className={preview ? "is-active" : ""}
                    type="button"
                    title={t("preview")}
                    aria-label={t("preview")}
                    onClick={() => setPreview(true)}
                  >
                    <Eye size={17} />
                  </button>
                  <button
                    type="button"
                    title={t("rename")}
                    aria-label={t("rename")}
                    onClick={() => void openEntryTextOperation("rename")}
                  >
                    <TextAa size={17} />
                  </button>
                  <button
                    type="button"
                    title={t("delete")}
                    aria-label={t("delete")}
                    onClick={() =>
                      selectedEntry &&
                      setEntryConfirmation({ kind: "delete", entry: selectedEntry })
                    }
                  >
                    <Trash size={17} />
                  </button>
                </div>
              </header>
              {conflict ? (
                <div className="knowledge-conflict" role="alert">
                  <p>{t("knowledgeConflict")}</p>
                  <button
                    type="button"
                    onClick={() => selectedEntry && void loadFile(selectedEntry, true)}
                  >
                    {t("reload")}
                  </button>
                  <button type="button" onClick={() => void openEntryTextOperation("save-copy")}>
                    {t("saveCopy")}
                  </button>
                </div>
              ) : null}
              {preview ? (
                <div className="knowledge-markdown-preview">
                  <MarkdownContent source={draft} />
                </div>
              ) : (
                <textarea
                  className="knowledge-markdown-editor"
                  value={draft}
                  onChange={(event) => {
                    const nextDraft = event.target.value;
                    setDraft(nextDraft);
                    markEdited({ draft: nextDraft });
                  }}
                  aria-label={t("markdownContent")}
                />
              )}
            </>
          ) : (
            <div className="knowledge-editor-empty">
              <FileText size={32} />
              <h2>{t("selectKnowledgeFile")}</h2>
              <p>{t("selectKnowledgeFileDescription")}</p>
            </div>
          )}
        </section>

        <aside className="knowledge-metadata-panel" aria-label={t("loadingSettings")}>
          <h2>{t("loadingSettings")}</h2>
          {selectedEntry?.kind === "file" && content !== null ? (
            <div className="knowledge-metadata-form">
              <label>
                {t("description")}
                <textarea
                  value={metadata.description ?? ""}
                  onChange={(event) => {
                    const nextMetadata = { ...metadata, description: event.target.value };
                    setMetadata(nextMetadata);
                    markEdited({ metadata: nextMetadata });
                  }}
                />
              </label>
              <div className="knowledge-metadata-field">
                <span>{t("loadingBehavior")}</span>
                <SelectMenu<ContextStoreContentMetadata["trigger"]>
                  ariaLabel={t("loadingBehavior")}
                  className="form-select"
                  value={metadata.trigger}
                  options={[
                    { value: "manual", label: t("onDemand") },
                    { value: "model_decision", label: t("modelDecides") },
                    { value: "always_on", label: t("loadImmediately") },
                  ]}
                  onChange={(trigger) => {
                    const nextMetadata = {
                      ...metadata,
                      trigger,
                    };
                    setMetadata(nextMetadata);
                    markEdited({ metadata: nextMetadata });
                  }}
                />
              </div>
              <div className="knowledge-metadata-field">
                <span>{t("priority")}</span>
                <SelectMenu<ContextStoreContentMetadata["priority"]>
                  ariaLabel={t("priority")}
                  className="form-select"
                  value={metadata.priority}
                  options={[
                    { value: "low", label: t("priorityLow") },
                    { value: "normal", label: t("priorityNormal") },
                    { value: "high", label: t("priorityHigh") },
                    { value: "critical", label: t("priorityCritical") },
                  ]}
                  onChange={(priority) => {
                    const nextMetadata = {
                      ...metadata,
                      priority,
                    };
                    setMetadata(nextMetadata);
                    markEdited({ metadata: nextMetadata });
                  }}
                />
              </div>
              <p>{t("frontmatterManaged")}</p>
            </div>
          ) : (
            <p className="knowledge-metadata-empty">{t("selectFileForSettings")}</p>
          )}
        </aside>
      </div>
      {error ? (
        <p className="form-error knowledge-base-error" role="alert">
          {error}
        </p>
      ) : null}
      {entryTextOperation !== null ? (
        <StudioTextInputDialog
          title={
            entryTextOperation.kind === "create-file"
              ? t("newFile")
              : entryTextOperation.kind === "create-folder"
                ? t("newFolder")
                : entryTextOperation.kind === "rename"
                  ? t("rename")
                  : t("saveCopy")
          }
          description={
            entryTextOperation.kind === "create-file"
              ? t("newMarkdownFilePrompt")
              : entryTextOperation.kind === "create-folder"
                ? t("newFolderPrompt")
                : entryTextOperation.kind === "rename"
                  ? t("renameEntryPrompt")
                  : t("saveCopyPrompt")
          }
          label={t("entryName")}
          value={entryTextOperation.value}
          hint={t("entryNameRules")}
          countValue={entryOperationName(entryTextOperation)}
          maxLength={PRAGMA_TEXT_LIMITS.contextStore.entryName}
          invalid={entryNameIssue !== undefined}
          cancelLabel={t("cancel")}
          confirmLabel={
            entryTextOperation.kind === "create-file"
              ? t("newFile")
              : entryTextOperation.kind === "create-folder"
                ? t("newFolder")
                : entryTextOperation.kind === "rename"
                  ? t("rename")
                  : t("saveCopy")
          }
          busyLabel={
            entryTextOperation.kind === "rename" || entryTextOperation.kind === "save-copy"
              ? t("saving")
              : t("creating")
          }
          busy={entryTextOperation.busy}
          error={entryTextOperation.error}
          onChange={(value) =>
            setEntryTextOperation((current) => {
              if (current === null) return null;
              const issue = pragmaKnowledgeBaseEntryNameIssue(entryOperationName(current, value));
              return {
                ...current,
                value,
                error:
                  issue === undefined || issue === "empty" ? null : entryNameIssueMessage(issue),
              };
            })
          }
          onCancel={() => setEntryTextOperation(null)}
          onConfirm={() => void submitEntryTextOperation()}
        />
      ) : null}
      {entryConfirmation !== null ? (
        <StudioConfirmationDialog
          title={entryConfirmation.kind === "delete" ? t("deleteEntryTitle") : t("moveEntryTitle")}
          description={
            entryConfirmation.kind === "delete"
              ? t("deleteEntryConfirm", { name: entryConfirmation.entry.id })
              : t("moveEntryDescription", {
                  name: entryConfirmation.entry.id,
                  destination:
                    entryConfirmation.destinationId === ""
                      ? t("knowledgeRoot")
                      : entryConfirmation.destinationId,
                })
          }
          cancelLabel={t("cancel")}
          confirmLabel={entryConfirmation.kind === "delete" ? t("delete") : t("moveEntryAction")}
          busyLabel={entryConfirmation.kind === "delete" ? t("deleting") : t("movingEntry")}
          busy={entryConfirmationBusy}
          action={entryConfirmation.kind === "move" ? "move" : "delete"}
          onCancel={() => setEntryConfirmation(null)}
          onConfirm={() => void confirmEntryOperation()}
        />
      ) : null}
      {confirmOpen ? (
        <StudioConfirmationDialog
          title={t("deleteKnowledgeBase")}
          description={t("deleteKnowledgeBaseDescription", { name: props.store.name })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteKnowledgeBaseAction")}
          busyLabel={t("deleting")}
          busy={deleting}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => void removeStore()}
        />
      ) : null}
    </StudioScreenFrame>
  );
}

export function ContextStoreCreatorDrawer(props: {
  readonly onClose: () => void;
  readonly onCreate: (input: CreateContextStore) => Promise<ContextStore>;
  readonly onInspectImport: (sourcePath: string) => Promise<ContextStoreImportInspection>;
  readonly onCreated: (store: ContextStore) => void;
  readonly onPickFolder: () => Promise<string | undefined>;
  readonly mountExpertName?: string;
}) {
  const { t } = useTranslation("studio");
  const [step, setStep] = useState<CreateStep>("intro");
  const [mode, setMode] = useState<CreateMode>("blank");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [sourcePath, setSourcePath] = useState("");
  const [inspection, setInspection] = useState<ContextStoreImportInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [inspecting, setInspecting] = useState(false);

  const chooseSource = async () => {
    try {
      const folder = await props.onPickFolder();
      if (!folder) return;
      setInspecting(true);
      setError(null);
      const result = await props.onInspectImport(folder);
      setSourcePath(folder);
      setInspection(result);
      if (!name.trim())
        setName(
          truncatePragmaTrimmedUnicode(fileName(folder), PRAGMA_TEXT_LIMITS.contextStore.name),
        );
    } catch (cause) {
      setInspection(null);
      setError(errorMessage(cause));
    } finally {
      setInspecting(false);
    }
  };

  const continueFromConfigure = () => {
    if (!name.trim() || (mode === "import" && inspection === null)) {
      setError(mode === "import" ? t("nameAndImportRequired") : t("knowledgeBaseNameRequired"));
      return;
    }
    if (inspection?.markdownFiles === 0) {
      setError(t("noMarkdownInSource"));
      return;
    }
    setError(null);
    setStep("review");
  };

  const submit = async () => {
    setSaving(true);
    setError(null);
    try {
      const common = { name: name.trim(), description: description.trim() };
      const input: CreateContextStore =
        mode === "blank" ? { mode: "blank", ...common } : { mode: "import", ...common, sourcePath };
      props.onCreated(await props.onCreate(input));
    } catch (cause) {
      setSaving(false);
      setError(errorMessage(cause));
    }
  };

  return (
    <div className="drawer-layer" role="presentation">
      <button
        className="drawer-scrim"
        type="button"
        aria-label={t("closeCreateKnowledgeBase")}
        onClick={props.onClose}
      />
      <aside className="store-creator-drawer" aria-labelledby="create-store-heading">
        <header className="drawer-heading">
          <h2 id="create-store-heading">{t("createKnowledgeBase")}</h2>
          <button type="button" aria-label={t("close")} onClick={props.onClose}>
            <X size={22} />
          </button>
        </header>
        <ol className="drawer-steps" aria-label={t("createKnowledgeBaseSteps")}>
          {(["intro", "configure", "review"] as const).map((item, index) => (
            <li className={step === item ? "is-active" : ""} key={item}>
              <span>{index + 1}</span>
              {item === "intro" ? t("format") : item === "configure" ? t("configure") : t("review")}
            </li>
          ))}
        </ol>

        <div className="drawer-body">
          {step === "intro" ? (
            <>
              <div className="drawer-copy">
                <h3>{t("markdownKnowledgeBase")}</h3>
                <p>{t("markdownKnowledgeBaseDescription")}</p>
              </div>
              <div className="store-type-options">
                <div className="is-selected">
                  <Folder size={26} />
                  <span>
                    <strong>Markdown</strong>
                    <small>{t("managedKnowledgeBase")}</small>
                    <em>{t("liveKnowledgeBase")}</em>
                  </span>
                  <Check size={18} />
                </div>
              </div>
            </>
          ) : null}

          {step === "configure" ? (
            <>
              <div className="drawer-copy">
                <h3>{t("configureKnowledgeBase")}</h3>
                <p>{t("configureKnowledgeBaseDescription")}</p>
              </div>
              <div className="knowledge-create-modes">
                <button
                  className={mode === "blank" ? "is-selected" : ""}
                  type="button"
                  onClick={() => setMode("blank")}
                >
                  <FilePlus size={23} />
                  <span>
                    <strong>{t("blankKnowledgeBase")}</strong>
                    <small>{t("blankKnowledgeBaseDescription")}</small>
                  </span>
                </button>
                <button
                  className={mode === "import" ? "is-selected" : ""}
                  type="button"
                  onClick={() => setMode("import")}
                >
                  <FolderPlus size={23} />
                  <span>
                    <strong>{t("importKnowledgeBase")}</strong>
                    <small>{t("importKnowledgeBaseDescription")}</small>
                  </span>
                </button>
              </div>
              <div className="store-config-form">
                <label>
                  {t("name")}
                  <input
                    value={name}
                    maxLength={PRAGMA_TEXT_LIMITS.contextStore.name * 2}
                    onChange={(event) =>
                      setName(
                        truncatePragmaTrimmedUnicode(
                          event.target.value,
                          PRAGMA_TEXT_LIMITS.contextStore.name,
                        ),
                      )
                    }
                    autoFocus
                  />
                  <CharacterCount value={name} max={PRAGMA_TEXT_LIMITS.contextStore.name} />
                </label>
                <label>
                  {t("description")}
                  <textarea
                    value={description}
                    maxLength={PRAGMA_TEXT_LIMITS.contextStore.description * 2}
                    onChange={(event) =>
                      setDescription(
                        truncatePragmaTrimmedUnicode(
                          event.target.value,
                          PRAGMA_TEXT_LIMITS.contextStore.description,
                        ),
                      )
                    }
                  />
                  <CharacterCount
                    value={description}
                    max={PRAGMA_TEXT_LIMITS.contextStore.description}
                  />
                </label>
                {mode === "import" ? (
                  <div className="knowledge-import-source">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={inspecting}
                      onClick={() => void chooseSource()}
                    >
                      {inspecting ? t("inspecting") : t("chooseSourceFolder")}
                    </button>
                    {inspection ? (
                      <div className="knowledge-import-summary">
                        <Check size={18} />
                        <div>
                          <strong>{fileName(inspection.sourcePath)}</strong>
                          <p>
                            {t("importScanSummary", {
                              markdown: inspection.markdownFiles,
                              ignored: inspection.ignoredFiles,
                            })}
                          </p>
                        </div>
                      </div>
                    ) : null}
                  </div>
                ) : (
                  <p className="store-availability-note">{t("managedLocationNote")}</p>
                )}
              </div>
            </>
          ) : null}

          {step === "review" ? (
            <>
              <div className="drawer-copy">
                <h3>{t("reviewKnowledgeBase")}</h3>
                <p>{t("reviewKnowledgeBaseDescription")}</p>
              </div>
              <dl className="store-review-list">
                <div>
                  <dt>{t("name")}</dt>
                  <dd>{name}</dd>
                </div>
                <div>
                  <dt>{t("creationMethod")}</dt>
                  <dd>{mode === "blank" ? t("blankKnowledgeBase") : t("copiedImport")}</dd>
                </div>
                <div>
                  <dt>{t("format")}</dt>
                  <dd>Markdown (.md)</dd>
                </div>
                {inspection ? (
                  <div>
                    <dt>{t("files")}</dt>
                    <dd>{t("markdownFileCount", { count: inspection.markdownFiles })}</dd>
                  </div>
                ) : null}
              </dl>
              {props.mountExpertName ? (
                <div className="mount-destination">
                  <FileText size={23} />
                  <p>
                    {t("afterCreationMounted", {
                      store: name,
                      expert: props.mountExpertName,
                    })}
                  </p>
                </div>
              ) : null}
            </>
          ) : null}
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>

        <footer className="drawer-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={saving}
            onClick={() => {
              if (step === "intro") props.onClose();
              else setStep(step === "review" ? "configure" : "intro");
            }}
          >
            {step === "intro" ? t("cancel") : t("back")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving}
            onClick={() => {
              if (step === "intro") setStep("configure");
              else if (step === "configure") continueFromConfigure();
              else void submit();
            }}
          >
            {saving
              ? t("creating")
              : step === "review"
                ? props.mountExpertName
                  ? t("createAndMount")
                  : t("createKnowledgeBase")
                : t("continue")}
          </button>
        </footer>
      </aside>
    </div>
  );
}

export function ExpertContextMountDrawer(props: {
  readonly expertName: string;
  readonly stores: readonly ContextStore[];
  readonly mounts: readonly ExpertContextStoreMount[];
  readonly onClose: () => void;
  readonly onSave: (mounts: readonly ExpertContextStoreMount[]) => Promise<void>;
  readonly onCreateStore: (input: CreateContextStore) => Promise<ContextStore>;
  readonly onInspectImport: (sourcePath: string) => Promise<ContextStoreImportInspection>;
  readonly onStoreCreated: (store: ContextStore) => void;
  readonly onPickFolder: () => Promise<string | undefined>;
}) {
  const { t } = useTranslation("studio");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<readonly ExpertContextStoreMount[]>(props.mounts);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const filteredStores = props.stores.filter((store) =>
    `${store.name} ${store.description}`.toLowerCase().includes(query.trim().toLowerCase()),
  );
  const toggleMount = (storeId: string) => {
    if (draft.some((mount) => mount.storeId === storeId)) {
      setDraft(
        draft
          .filter((mount) => mount.storeId !== storeId)
          .map((mount, priority) => ({ ...mount, priority })),
      );
    } else {
      setDraft([...draft, { storeId, enabled: true, priority: draft.length }]);
    }
  };

  if (creating) {
    return (
      <ContextStoreCreatorDrawer
        mountExpertName={props.expertName}
        onClose={() => setCreating(false)}
        onCreate={props.onCreateStore}
        onInspectImport={props.onInspectImport}
        onPickFolder={props.onPickFolder}
        onCreated={(store) => {
          props.onStoreCreated(store);
          setDraft([...draft, { storeId: store.id, enabled: true, priority: draft.length }]);
          setCreating(false);
        }}
      />
    );
  }

  return (
    <div className="drawer-layer" role="presentation">
      <button
        className="drawer-scrim"
        type="button"
        aria-label={t("closeContextConfiguration")}
        onClick={props.onClose}
      />
      <aside
        className="store-creator-drawer context-mount-drawer"
        aria-labelledby="mount-context-heading"
      >
        <header className="drawer-heading">
          <div>
            <h2 id="mount-context-heading">{t("addKnowledgeBase")}</h2>
            <p>{t("chooseKnowledgeForExpert", { expert: props.expertName })}</p>
          </div>
          <button type="button" aria-label={t("close")} onClick={props.onClose}>
            <X size={22} />
          </button>
        </header>
        <div className="drawer-body">
          <label className="directory-search mount-search">
            <MagnifyingGlass size={18} />
            <span className="sr-only">{t("searchKnowledgeBases")}</span>
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t("searchKnowledgeBases")}
            />
          </label>
          <div className="mount-store-list">
            {filteredStores.map((store) => {
              const mount = draft.find((item) => item.storeId === store.id);
              return (
                <div
                  className={mount ? "mount-store-row is-selected" : "mount-store-row"}
                  key={store.id}
                >
                  <button
                    type="button"
                    className="mount-store-toggle"
                    onClick={() => toggleMount(store.id)}
                  >
                    <span className="store-icon">
                      <Folder size={21} />
                    </span>
                    <span>
                      <strong>{store.name}</strong>
                      <small>Markdown</small>
                    </span>
                    <span className="mount-checkbox" aria-label={mount ? "Mounted" : "Not mounted"}>
                      {mount ? <Check size={15} /> : null}
                    </span>
                  </button>
                  {mount ? (
                    <p className="mount-trigger-summary">{t("fileMetadataLoading")}</p>
                  ) : null}
                </div>
              );
            })}
            {filteredStores.length === 0 ? (
              <p className="mount-empty">{t("noMatchingStores")}</p>
            ) : null}
          </div>
          <button className="create-inline-store" type="button" onClick={() => setCreating(true)}>
            <Plus size={18} />
            <span>
              <strong>{t("createKnowledgeBase")}</strong>
              <small>{t("createKnowledgeBaseInlineDescription")}</small>
            </span>
            <CaretRight size={17} />
          </button>
          {error ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </div>
        <footer className="drawer-actions">
          <button
            className="secondary-button"
            type="button"
            onClick={props.onClose}
            disabled={saving}
          >
            {t("cancel")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void props.onSave(draft).catch((cause: unknown) => {
                setSaving(false);
                setError(errorMessage(cause));
              });
            }}
          >
            {saving ? t("saving") : t("saveMountedKnowledge", { count: draft.length })}
          </button>
        </footer>
      </aside>
    </div>
  );
}
