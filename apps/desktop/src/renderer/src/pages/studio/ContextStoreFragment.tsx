import {
  ArrowLeft,
  CaretRight,
  Check,
  ClockCounterClockwise,
  Database,
  DownloadSimple,
  FileText,
  Circle,
  RadioButton,
  FloppyDisk,
  Folder,
  GearSix,
  GitBranch,
  MagnifyingGlass,
  PaperPlaneTilt,
  Plus,
  Question,
  SpinnerGap,
  Trash,
  X,
} from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState, useId } from "react";
import { useTranslation } from "react-i18next";
import type { ContextStoreRevisionJob } from "@pragma/built-in-agents/contracts";
import { PRAGMA_TEXT_LIMITS, truncatePragmaTrimmedUnicode } from "@pragma/shared";

import type {
  ContextStore,
  ContextStoreContent,
  ContextStoreContentMetadata,
  ContextStoreEntry,
  ContextStoreImportInspection,
  CreateContextStore,
  ExpertContextStoreMount,
  ContextStoreEditorDraft,
} from "../../../../shared/contracts/index.ts";
import { CharacterCount } from "../../components/CharacterCount.tsx";
import { Dialog } from "../../components/Dialog.tsx";
import { AssetFileWorkspace } from "./AssetFileWorkspace.tsx";
import { fileName, rebaseEntryId } from "./asset-file-paths.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { StudioActionButton } from "../../components/StudioActionButton.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { SIDEBAR_WIDTH_PREFERENCES } from "../../lib/sidebar-width-preference.ts";
import {
  flushContextStoreSaves,
  type ContextStoreSaveCoordinator,
} from "./context-store-autosave.ts";
import { StudioConfirmationDialog } from "./StudioDialog.tsx";
import { StudioScreenFrame, type StudioLeaveGuard } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";
import { AssetGitImportForm, AssetGitPanel } from "./AssetGitControls.tsx";
import type { AssetGitTarget } from "../../../../shared/contracts/index.ts";

type CreateStep = "intro" | "configure" | "review";
type CreateMode = CreateContextStore["mode"];
type SaveStatus = "idle" | "saving" | "saved" | "published" | "error";
type EditorStateSnapshot = {
  readonly selectedEntry: ContextStoreEntry | null;
  readonly content: ContextStoreContent | null;
  readonly draft: string;
  readonly metadata: ContextStoreContentMetadata;
  readonly dirty: boolean;
  readonly editVersion: number;
  readonly documentVersion: number;
};

type LoadFileOptions = {
  readonly discardChanges?: boolean;
  readonly preservePreview?: boolean;
};

const DEFAULT_METADATA: ContextStoreContentMetadata = {
  trigger: "manual",
  priority: "normal",
};
type ContextStoreDeleteError = {
  readonly code?: string | undefined;
  readonly message: string;
};

export type ContextStoreMissionMountCheck = {
  readonly storeId: string;
  readonly status: "checking" | "mounted" | "unmounted" | "unknown";
  readonly count?: number;
};

export function contextStoreDeleteError(error: unknown): ContextStoreDeleteError {
  const code =
    typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
      ? error.code
      : undefined;
  return { ...(code === undefined ? {} : { code }), message: errorMessage(error) };
}

export function contextStoreDeleteCheckPending(
  check: ContextStoreMissionMountCheck | null,
  storeId: string,
): boolean {
  return check?.storeId !== storeId || check.status === "checking" || check.status === "unknown";
}

export function firstContextStoreFile(
  entries: readonly ContextStoreEntry[],
): ContextStoreEntry | undefined {
  return entries.find((entry) => entry.kind === "file");
}

export function contextStorePreviewAfterLoad(
  currentPreview: boolean,
  preservePreview: boolean,
): boolean {
  return preservePreview ? currentPreview : true;
}

export function ContextStoreDirectoryFragment(props: {
  readonly stores: readonly ContextStore[];
  readonly revisionTaskCount?: number | undefined;
  readonly onOpenRevisions?: (() => void) | undefined;
  readonly onCreate: (input: CreateContextStore) => Promise<ContextStore>;
  readonly onInspectImport: (sourcePath: string) => Promise<ContextStoreImportInspection>;
  readonly onPickFolder: () => Promise<string | undefined>;
  readonly onOpen: (store: ContextStore) => void;
  readonly onGitImported?: ((target: AssetGitTarget) => Promise<void>) | undefined;
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
          <div className="knowledge-directory-actions">
            {props.onOpenRevisions !== undefined ? (
              <button className="secondary-button" type="button" onClick={props.onOpenRevisions}>
                <ClockCounterClockwise size={17} aria-hidden="true" />
                {t("revisionTasks")}
                {(props.revisionTaskCount ?? 0) > 0 ? (
                  <span className="revision-task-count">{props.revisionTaskCount}</span>
                ) : null}
              </button>
            ) : null}
            <button className="primary-button" type="button" onClick={() => setCreating(true)}>
              <Plus size={17} aria-hidden="true" />
              {t("createKnowledgeBase")}
            </button>
          </div>
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
          onGitImported={props.onGitImported}
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
  readonly onUpdateWriteApproval?: (
    mode: ContextStore["writeApprovalMode"],
  ) => Promise<ContextStore>;
  readonly onBack: () => void;
  readonly onOpenRevisions?: (() => void) | undefined;
  readonly onExport?: (() => Promise<void>) | undefined;
  readonly onPublish?: (() => Promise<void>) | undefined;
  readonly onSubmitRevision?:
    ((prompt: string) => Promise<ContextStoreRevisionJob | undefined>) | undefined;
  readonly onRevisionSubmitted?: ((job: ContextStoreRevisionJob | undefined) => void) | undefined;
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
  readonly onGetEditorDraft: (storeId: string) => Promise<ContextStoreEditorDraft | undefined>;
  readonly onCommitEditorDraft: (
    storeId: string,
    expectedRevision: number,
  ) => Promise<ContextStore>;
  readonly onDiscardEditorDraft: (storeId: string, expectedRevision: number) => Promise<void>;
  readonly onStoreChanged: (store: ContextStore) => void;
  readonly onLeaveGuardChange?: ((guard: StudioLeaveGuard | null) => void) | undefined;
  readonly openGitSettingsRequest?: number | undefined;
}) {
  const { t } = useTranslation("studio");
  const [entries, setEntries] = useState<readonly ContextStoreEntry[]>([]);
  const [collapsedDirectoryIds, setCollapsedDirectoryIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const [selectedEntry, setSelectedEntry] = useState<ContextStoreEntry | null>(null);
  const [content, setContent] = useState<ContextStoreContent | null>(null);
  const [draft, setDraft] = useState("");
  const [metadata, setMetadata] = useState<ContextStoreContentMetadata>(DEFAULT_METADATA);
  const [dirty, setDirty] = useState(false);
  const [draftDirty, setDraftDirty] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const [preview, setPreview] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<ContextStoreDeleteError | null>(null);
  const [missionMountCheck, setMissionMountCheck] = useState<ContextStoreMissionMountCheck | null>(
    null,
  );
  const deleteBlockedByRevisionDrafts = deleteError?.code === "revision_drafts_present";
  const deleteBlockedByReferences = deleteError?.code === "expert_referenced";
  const deleteActiveMission = deleteError?.code === "active_mission_referenced";
  const deleteMissionMessagesPending = deleteError?.code === "mission_message_queue_referenced";
  const deleteMissionUnmountFailed =
    deleteError?.code === "mission_unmount_failed" || deleteError?.code === "mission_referenced";
  const hasMissionMounts =
    missionMountCheck?.storeId === props.store.id && missionMountCheck.status === "mounted";
  const missionMountCheckPending = contextStoreDeleteCheckPending(
    missionMountCheck,
    props.store.id,
  );
  const [revisionDialogOpen, setRevisionDialogOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [approvalSaving, setApprovalSaving] = useState(false);
  const settingsCloseRef = useRef<HTMLButtonElement>(null);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const [revisionPrompt, setRevisionPrompt] = useState("");
  const [revisionSubmitting, setRevisionSubmitting] = useState(false);
  const [revisionError, setRevisionError] = useState<string | null>(null);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (props.openGitSettingsRequest !== undefined) setSettingsOpen(true);
  }, [props.openGitSettingsRequest]);

  useEffect(() => {
    if (!confirmOpen) return;
    if (missionMountCheck?.storeId !== props.store.id) {
      setMissionMountCheck({ storeId: props.store.id, status: "checking" });
      return;
    }
    if (missionMountCheck.status !== "checking") return;
    let active = true;
    const api = desktopApi();
    void Promise.resolve()
      .then(async () =>
        api === undefined
          ? undefined
          : await api.countContextStoreMissionReferences({ storeId: props.store.id }),
      )
      .then((count) => {
        if (active) {
          setMissionMountCheck({
            storeId: props.store.id,
            status: count === undefined ? "unknown" : count > 0 ? "mounted" : "unmounted",
            ...(count === undefined ? {} : { count }),
          });
        }
      })
      .catch(() => {
        if (active) setMissionMountCheck({ storeId: props.store.id, status: "unknown" });
      });
    return () => {
      active = false;
    };
  }, [confirmOpen, missionMountCheck, props.store.id]);

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
    async (entry: ContextStoreEntry, options: LoadFileOptions = {}) => {
      const request = loadRequestRef.current + 1;
      loadRequestRef.current = request;
      const editVersionAtStart = editVersionRef.current;
      try {
        const loaded = await props.onGetContent(props.store.id, entry.id);
        if (loadRequestRef.current !== request) return;
        if (
          !options.discardChanges &&
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
        setContent(loaded);
        setDraft(loaded.content);
        setMetadata(loaded.metadata);
        setDirty(false);
        setConflict(false);
        setSaveStatus("idle");
        setPreview((currentPreview) =>
          contextStorePreviewAfterLoad(currentPreview, options.preservePreview === true),
        );
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
          setDraftDirty(true);
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
      void (async () => {
        try {
          const editorDraft = await props.onGetEditorDraft(props.store.id);
          const current = currentRef.current;
          if (
            editorDraft !== undefined ||
            current.dirty ||
            saveCoordinatorRef.current.inFlight !== null
          ) {
            setConflict(true);
            return;
          }
          await loadEntries();
          if (current.selectedEntry?.kind === "file") {
            await loadFile(current.selectedEntry, { preservePreview: true });
          }
        } catch (cause) {
          setError(errorMessage(cause));
        }
      })();
    });
  }, [loadEntries, loadFile, props.onGetEditorDraft, props.onSubscribe, props.store.id]);

  useEffect(() => {
    if (loading || selectedEntry !== null) return;
    const firstFile = firstContextStoreFile(entries);
    if (firstFile !== undefined) void loadFile(firstFile);
  }, [entries, loadFile, loading, selectedEntry]);

  useEffect(() => {
    setCollapsedDirectoryIds(new Set());
  }, [props.store.id]);

  useEffect(() => {
    let cancelled = false;
    void props.onGetEditorDraft(props.store.id).then((editorDraft) => {
      if (!cancelled) setDraftDirty(editorDraft !== undefined);
    });
    return () => {
      cancelled = true;
    };
  }, [props.onGetEditorDraft, props.store.id]);

  useEffect(() => {
    if (!dirty && !draftDirty) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [dirty, draftDirty]);

  useEffect(() => {
    if (!dirty) return;
    const timeout = window.setTimeout(() => void save(), 500);
    return () => window.clearTimeout(timeout);
  }, [autosaveVersion, dirty, save]);

  const openEntry = async (entry: ContextStoreEntry) => {
    if (entry.kind === "directory") {
      if (await save()) {
        setSelectedEntry(entry);
        setContent(null);
        setCollapsedDirectoryIds((current) => {
          const next = new Set(current);
          if (next.has(entry.id)) next.delete(entry.id);
          else next.add(entry.id);
          return next;
        });
      }
      return;
    }
    if (selectedEntry?.id === entry.id) return;
    if (await save()) await loadFile(entry);
  };

  const commitDraft = useCallback(async (): Promise<boolean> => {
    if (!(await save())) return false;
    try {
      const editorDraft = await props.onGetEditorDraft(props.store.id);
      if (editorDraft === undefined) {
        setDraftDirty(false);
        return true;
      }
      setSaveStatus("saving");
      const nextStore = await props.onCommitEditorDraft(props.store.id, editorDraft.revision);
      props.onStoreChanged(nextStore);
      setDraftDirty(false);
      setSaveStatus("published");
      await loadEntries();
      const selected = currentRef.current.selectedEntry;
      if (selected?.kind === "file") {
        await loadFile(selected, { discardChanges: true, preservePreview: true });
      }
      return true;
    } catch (cause) {
      setSaveStatus("error");
      setError(errorMessage(cause));
      return false;
    }
  }, [
    loadEntries,
    loadFile,
    props.onCommitEditorDraft,
    props.onGetEditorDraft,
    props.onStoreChanged,
    props.store.id,
    save,
  ]);

  useEffect(() => {
    const handleSaveShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void commitDraft();
      }
    };
    window.addEventListener("keydown", handleSaveShortcut);
    return () => window.removeEventListener("keydown", handleSaveShortcut);
  }, [commitDraft]);

  const requestLeave = useCallback(
    (action: () => void): void => {
      if (!dirty && !draftDirty) {
        action();
        return;
      }
      setLeaveAction(() => action);
    },
    [dirty, draftDirty],
  );

  useEffect(() => {
    props.onLeaveGuardChange?.(requestLeave);
    return () => props.onLeaveGuardChange?.(null);
  }, [props.onLeaveGuardChange, requestLeave]);

  const discardAndLeave = async (): Promise<void> => {
    if (leaveAction === null) return;
    setLeaving(true);
    try {
      const editorDraft = await props.onGetEditorDraft(props.store.id);
      if (editorDraft !== undefined) {
        await props.onDiscardEditorDraft(props.store.id, editorDraft.revision);
      }
      const action = leaveAction;
      setDraftDirty(false);
      setDirty(false);
      setLeaveAction(null);
      action();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLeaving(false);
    }
  };

  const saveAndLeave = async (): Promise<void> => {
    if (leaveAction === null) return;
    setLeaving(true);
    const action = leaveAction;
    if (await commitDraft()) {
      setLeaveAction(null);
      action();
    }
    setLeaving(false);
  };

  const createFile = async (id: string, copy: boolean): Promise<void> => {
    const created = await props.onCreateFile(
      props.store.id,
      id,
      copy ? draft : "",
      copy ? metadata : { ...DEFAULT_METADATA, description: fileName(id).replace(/\.md$/iu, "") },
    );
    await loadEntries();
    await loadFile({ id, kind: "file", revision: created.revision });
    setDraftDirty(true);
  };

  const renameEntry = async (entry: ContextStoreEntry, nextId: string): Promise<void> => {
    await props.onRenameEntry(props.store.id, entry.id, nextId, entry.kind);
    const selected = currentRef.current.selectedEntry;
    const rebasedId = selected === null ? undefined : rebaseEntryId(selected.id, entry.id, nextId);
    const nextSelection =
      selected !== null && rebasedId !== undefined ? { ...selected, id: rebasedId } : selected;
    if (nextSelection !== null && rebasedId !== undefined) {
      setSelectedEntry(nextSelection);
      if (nextSelection.kind === "file") await loadFile(nextSelection, { discardChanges: true });
    }
    await loadEntries(nextSelection);
    setDraftDirty(true);
  };

  const deleteEntry = async (entry: ContextStoreEntry): Promise<void> => {
    await props.onDeleteEntry(props.store.id, entry.id, entry.kind);
    const selectedId = currentRef.current.selectedEntry?.id;
    const removed = selectedId === entry.id || selectedId?.startsWith(`${entry.id}/`) === true;
    await loadEntries(removed ? null : undefined);
    if (removed) {
      loadRequestRef.current++;
      currentRef.current = {
        ...currentRef.current,
        selectedEntry: null,
        content: null,
        draft: "",
        dirty: false,
      };
      setSelectedEntry(null);
      setContent(null);
      setDraft("");
      setDirty(false);
    }
    setDraftDirty(true);
  };

  const removeStore = async () => {
    if (missionMountCheckPending) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      const editorDraft = await props.onGetEditorDraft(props.store.id);
      if (editorDraft !== undefined) {
        await props.onDiscardEditorDraft(props.store.id, editorDraft.revision);
      }
      await props.onDelete();
    } catch (cause) {
      setDeleteError(contextStoreDeleteError(cause));
      setMissionMountCheck({ storeId: props.store.id, status: "checking" });
    } finally {
      setDeleting(false);
    }
  };

  const openDeleteConfirmation = () => {
    setDeleteError(null);
    setMissionMountCheck({ storeId: props.store.id, status: "checking" });
    setConfirmOpen(true);
  };

  const submitRevision = async () => {
    if (props.onSubmitRevision === undefined || revisionPrompt.trim() === "") return;
    setRevisionSubmitting(true);
    setRevisionError(null);
    try {
      const job = await props.onSubmitRevision(revisionPrompt.trim());
      setRevisionDialogOpen(false);
      setRevisionPrompt("");
      props.onRevisionSubmitted?.(job);
    } catch (cause) {
      setRevisionError(errorMessage(cause));
    } finally {
      setRevisionSubmitting(false);
    }
  };

  return (
    <StudioScreenFrame
      className="knowledge-base-editor"
      labelledBy="context-store-name"
      header={
        <div className="knowledge-base-editor-header">
          <button className="back-link" type="button" onClick={() => requestLeave(props.onBack)}>
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
          <div className="knowledge-base-editor-actions">
            <StudioActionButton
              label={saveStatus === "saving" ? t("saving") : t("saveKnowledgeBase")}
              tooltip={
                saveStatus === "saving"
                  ? t("saving")
                  : !dirty && !draftDirty
                    ? t("noKnowledgeChangesToSave")
                    : t("saveKnowledgeBase")
              }
              tone="primary"
              disabled={(!dirty && !draftDirty) || saveStatus === "saving"}
              busy={saveStatus === "saving"}
              icon={
                saveStatus === "saving" ? (
                  <SpinnerGap className="spin" size={18} aria-hidden="true" />
                ) : (
                  <FloppyDisk size={18} aria-hidden="true" />
                )
              }
              onClick={() => void commitDraft()}
            />
            {props.onSubmitRevision !== undefined ? (
              <StudioActionButton
                label={t("submitStoreRevision")}
                icon={<PaperPlaneTilt size={18} aria-hidden="true" />}
                onClick={() =>
                  requestLeave(() => {
                    setRevisionError(null);
                    setRevisionDialogOpen(true);
                  })
                }
              />
            ) : null}
            {props.onExport !== undefined ? (
              <StudioActionButton
                label={t("exportBundle")}
                icon={<DownloadSimple size={18} aria-hidden="true" />}
                onClick={() => {
                  setError(null);
                  void props.onExport!().catch((cause: unknown) => setError(errorMessage(cause)));
                }}
              />
            ) : null}
            {props.onPublish !== undefined ? (
              <StudioActionButton
                label={t("publishToSource")}
                icon={<GitBranch size={18} aria-hidden="true" />}
                onClick={() =>
                  requestLeave(() => {
                    setError(null);
                    void props.onPublish!().catch((cause: unknown) =>
                      setError(errorMessage(cause)),
                    );
                  })
                }
              />
            ) : null}
            <StudioActionButton
              label={t("assetGit.settings")}
              icon={<GearSix size={18} aria-hidden="true" />}
              onClick={() => requestLeave(() => setSettingsOpen(true))}
            />
            <StudioActionButton
              label={t("delete")}
              tone="danger"
              icon={<Trash size={18} aria-hidden="true" />}
              onClick={openDeleteConfirmation}
            />
          </div>
        </div>
      }
    >
      <AssetFileWorkspace
        filesLabel={t("knowledgeBaseFiles")}
        resizeLabel={t("resizeKnowledgeFileList")}
        widthPreference={SIDEBAR_WIDTH_PREFERENCES.knowledgeBaseFiles}
        entries={entries}
        selectedEntry={selectedEntry}
        collapsedDirectoryIds={collapsedDirectoryIds}
        onOpenEntry={(entry) => void openEntry(entry)}
        loading={loading}
        onRefresh={() => loadEntries()}
        markdownFileNames
        extractFrontmatter
        operations={{
          beforeOperation: save,
          createFile,
          createFolder: async (id) => {
            await props.onCreateFolder(props.store.id, id);
            await loadEntries();
            setDraftDirty(true);
          },
          renameEntry,
          deleteEntry,
        }}
        editor={
          selectedEntry?.kind === "file" && content !== null
            ? {
                path: selectedEntry.id,
                value: draft,
                preview,
                onPreviewChange: setPreview,
                onChange: (nextDraft) => {
                  setDraft(nextDraft);
                  markEdited({ draft: nextDraft });
                },
                status: (
                  <span className={`knowledge-save-status is-${saveStatus}`}>
                    {saveStatus === "saving"
                      ? t("saving")
                      : saveStatus === "saved"
                        ? t("draftBackedUp")
                        : saveStatus === "published"
                          ? t("saved")
                          : saveStatus === "error"
                            ? t("saveFailed")
                            : ""}
                  </span>
                ),
              }
            : null
        }
        editorChildren={({ saveCopy }) =>
          conflict ? (
            <div className="knowledge-conflict" role="alert">
              <p>{t("knowledgeConflict")}</p>
              {draftDirty ? (
                <button type="button" onClick={() => void commitDraft()}>
                  {t("saveKnowledgeBase")}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() =>
                      selectedEntry && void loadFile(selectedEntry, { discardChanges: true })
                    }
                  >
                    {t("reload")}
                  </button>
                  <button type="button" onClick={saveCopy}>
                    {t("saveCopy")}
                  </button>
                </>
              )}
            </div>
          ) : null
        }
        emptyEditor={
          <>
            <FileText size={32} />
            <h2>{t("selectKnowledgeFile")}</h2>
            <p>{t("selectKnowledgeFileDescription")}</p>
          </>
        }
        metadataPanel={
          <aside className="knowledge-metadata-panel" aria-label={t("loadingSettings")}>
            <h2>{t("loadingSettings")}</h2>
            {selectedEntry?.kind === "file" && content !== null ? (
              <KnowledgeLoadingSettings
                metadata={metadata}
                onChange={(nextMetadata) => {
                  setMetadata(nextMetadata);
                  markEdited({ metadata: nextMetadata });
                }}
              />
            ) : (
              <p className="knowledge-metadata-empty">{t("selectFileForSettings")}</p>
            )}
          </aside>
        }
      />
      {error ? (
        <p className="form-error knowledge-base-error" role="alert">
          {error}
        </p>
      ) : null}
      {leaveAction !== null ? (
        <Dialog
          title={t("unsavedKnowledgeChangesTitle")}
          description={t("unsavedKnowledgeChangesDescription")}
          role="alertdialog"
          busy={leaving}
          onCancel={() => setLeaveAction(null)}
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={leaving}
                onClick={() => setLeaveAction(null)}
              >
                {t("cancel")}
              </button>
              <button
                className="danger-button"
                type="button"
                disabled={leaving}
                onClick={() => void discardAndLeave()}
              >
                {t("discardAndLeave")}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={leaving}
                onClick={() => void saveAndLeave()}
              >
                {leaving ? t("saving") : t("saveAndLeave")}
              </button>
            </>
          }
        />
      ) : null}
      {settingsOpen ? (
        <Dialog
          title={t("knowledgeBaseSettings")}
          className="asset-git-dialog knowledge-settings-dialog"
          busy={approvalSaving}
          onCancel={() => setSettingsOpen(false)}
          headerAction={
            <button
              className="icon-button"
              type="button"
              aria-label={t("close")}
              title={t("close")}
              ref={settingsCloseRef}
              aria-disabled={approvalSaving}
              onClick={() => {
                if (!approvalSaving) setSettingsOpen(false);
              }}
            >
              <X size={20} aria-hidden="true" />
            </button>
          }
        >
          <section
            className="knowledge-settings-section"
            aria-labelledby="knowledge-write-approval-label"
          >
            <h3 id="knowledge-write-approval-label">{t("writeApproval")}</h3>
            <SelectMenu<ContextStore["writeApprovalMode"]>
              ariaLabel={t("writeApproval")}
              className="form-select"
              portal={false}
              value={props.store.writeApprovalMode}
              disabled={approvalSaving || props.onUpdateWriteApproval === undefined}
              options={[
                { value: "required", label: t("writeApprovalRequired") },
                { value: "auto", label: t("writeApprovalAuto") },
              ]}
              onChange={(mode) => {
                // Keep focus inside the dialog while the select trigger is disabled.
                settingsCloseRef.current?.focus();
                setApprovalSaving(true);
                setApprovalError(null);
                void props.onUpdateWriteApproval!(mode)
                  .then(props.onStoreChanged)
                  .catch((cause: unknown) => setApprovalError(errorMessage(cause)))
                  .finally(() => setApprovalSaving(false));
              }}
            />
            <p className="knowledge-settings-help">{t("writeApprovalHelp")}</p>
            {approvalError !== null ? (
              <p className="form-error" role="alert">
                {approvalError}
              </p>
            ) : null}
          </section>
          <section
            className="knowledge-settings-section"
            aria-labelledby="knowledge-git-settings-label"
          >
            <h3 id="knowledge-git-settings-label">{t("assetGit.title")}</h3>
            <p className="knowledge-settings-help">{t("assetGit.description")}</p>
            <AssetGitPanel
              target={{ kind: "knowledge", id: props.store.id }}
              showHeading={false}
              beforeSync={async () => {
                if (!(await commitDraft())) throw new Error(t("assetGit.saveFailed"));
              }}
              onSynced={async () => {
                const api = desktopApi();
                if (!api) return;
                const next = (await api.listContextStores()).find(
                  (item) => item.id === props.store.id,
                );
                if (next) props.onStoreChanged(next);
                await loadEntries();
                const selected = currentRef.current.selectedEntry;
                if (
                  selected?.kind === "file" &&
                  (await props.onListEntries(props.store.id)).some(
                    (entry) => entry.kind === "file" && entry.id === selected.id,
                  )
                ) {
                  await loadFile(selected, { discardChanges: true, preservePreview: true });
                }
              }}
            />
          </section>
        </Dialog>
      ) : null}
      {revisionDialogOpen ? (
        <Dialog
          title={t("submitStoreRevision")}
          description={t("submitStoreRevisionDescription", { name: props.store.name })}
          busy={revisionSubmitting}
          onCancel={() => {
            setRevisionDialogOpen(false);
            setRevisionError(null);
          }}
          className="knowledge-revision-dialog"
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={revisionSubmitting}
                onClick={() => setRevisionDialogOpen(false)}
              >
                {t("cancel")}
              </button>
              <button
                className="primary-button"
                type="submit"
                form="knowledge-revision-form"
                disabled={revisionSubmitting || revisionPrompt.trim() === ""}
              >
                {revisionSubmitting ? t("submittingRevision") : t("submitStoreRevision")}
              </button>
            </>
          }
        >
          <form
            id="knowledge-revision-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submitRevision();
            }}
          >
            <label>
              <span>{t("revisionPrompt")}</span>
              <textarea
                data-dialog-initial-focus
                value={revisionPrompt}
                maxLength={50_000}
                disabled={revisionSubmitting}
                placeholder={t("revisionPromptPlaceholder")}
                onChange={(event) => setRevisionPrompt(event.target.value)}
              />
            </label>
            <div className="knowledge-revision-dialog-meta">
              <small>{t("revisionPromptHint")}</small>
              <CharacterCount value={revisionPrompt} max={50_000} trim={false} />
            </div>
            {revisionError !== null ? (
              <p className="form-error" role="alert">
                {revisionError}
              </p>
            ) : null}
          </form>
        </Dialog>
      ) : null}
      {confirmOpen ? (
        <StudioConfirmationDialog
          title={t("deleteKnowledgeBase")}
          description={t("deleteKnowledgeBaseDescription", { name: props.store.name })}
          warning={
            hasMissionMounts
              ? t("knowledgeBaseMissionMountWarning", { count: missionMountCheck?.count })
              : null
          }
          error={
            missionMountCheck?.status === "unknown"
              ? t("knowledgeBaseMissionCountFailed")
              : deleteBlockedByRevisionDrafts
                ? t("knowledgeBaseRevisionTasksBlocked")
                : deleteError?.code === "draft_unreadable"
                  ? t("knowledgeBaseRevisionDraftUnreadable")
                  : deleteBlockedByReferences
                    ? t("knowledgeBaseStillReferenced")
                    : deleteMissionUnmountFailed
                      ? t("knowledgeBaseMissionUnmountFailed")
                      : deleteActiveMission
                        ? t("knowledgeBaseActiveMission")
                        : deleteMissionMessagesPending
                          ? t("knowledgeBaseMissionMessagesPending")
                          : deleteError?.message
          }
          errorAction={
            deleteBlockedByRevisionDrafts && props.onOpenRevisions !== undefined
              ? { label: t("revisionTasks"), onClick: props.onOpenRevisions }
              : undefined
          }
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteKnowledgeBaseAction")}
          busyLabel={t("deleting")}
          busy={deleting}
          confirmDisabled={missionMountCheckPending}
          onCancel={() => {
            setDeleteError(null);
            setMissionMountCheck(null);
            setConfirmOpen(false);
          }}
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
  readonly onGitImported?: ((target: AssetGitTarget) => Promise<void>) | undefined;
  readonly mountExpertName?: string;
}) {
  const { t } = useTranslation("studio");
  const methodGroupId = useId();
  const [step, setStep] = useState<CreateStep>("intro");
  const [creationSource, setCreationSource] = useState<"local" | "git">("local");
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
    if (creationSource === "git") return;
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
                <div>
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
              </div>
              <fieldset className="knowledge-create-methods">
                <legend>{t("creationMethod")}</legend>
                {(
                  [
                    {
                      value: "blank",
                      icon: FileText,
                      title: t("blankKnowledgeBase"),
                      description: t("blankKnowledgeBaseDescription"),
                    },
                    {
                      value: "import",
                      icon: Folder,
                      title: t("importKnowledgeBase"),
                      description: t("importKnowledgeBaseDescription"),
                    },
                    ...(props.onGitImported
                      ? [
                          {
                            value: "git",
                            icon: GitBranch,
                            title: t("assetGit.import"),
                            description: t("assetGit.importDescription"),
                          },
                        ]
                      : []),
                  ] as const
                ).map((method) => {
                  const selected =
                    creationSource === "git" ? method.value === "git" : method.value === mode;
                  const Icon = method.icon;
                  return (
                    <label
                      className={`knowledge-create-method${selected ? " is-selected" : ""}`}
                      key={method.value}
                    >
                      <input
                        type="radio"
                        name={methodGroupId}
                        value={method.value}
                        autoFocus={selected}
                        checked={selected}
                        onChange={() => {
                          setCreationSource(method.value === "git" ? "git" : "local");
                          if (method.value === "blank" || method.value === "import") {
                            setMode(method.value);
                          }
                          setError(null);
                        }}
                      />
                      <Icon size={20} aria-hidden="true" />
                      <span className="knowledge-create-method-copy">
                        <span>{method.title}</span>
                        <small>{method.description}</small>
                      </span>
                      {selected ? (
                        <RadioButton
                          className="knowledge-create-method-indicator"
                          size={20}
                          weight="fill"
                          aria-hidden="true"
                        />
                      ) : (
                        <Circle
                          className="knowledge-create-method-indicator"
                          size={20}
                          aria-hidden="true"
                        />
                      )}
                    </label>
                  );
                })}
              </fieldset>
              {creationSource === "git" && props.onGitImported ? (
                <AssetGitImportForm
                  kind="knowledge"
                  onImported={async (target) => {
                    await props.onGitImported?.(target);
                    props.onClose();
                  }}
                />
              ) : (
                <>
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
                      <p className="knowledge-create-location">
                        <Folder size={16} aria-hidden="true" />
                        {t("managedLocationNote")}
                      </p>
                    )}
                  </div>
                </>
              )}
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
          {creationSource === "git" && step === "configure" ? null : (
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
          )}
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
                    aria-pressed={mount !== undefined}
                    onClick={() => toggleMount(store.id)}
                  >
                    <span className="store-icon">
                      <Folder size={21} />
                    </span>
                    <span>
                      <strong>{store.name}</strong>
                      <small>Markdown</small>
                    </span>
                    <span className="mount-checkbox" aria-hidden="true">
                      {mount ? <Check size={15} /> : null}
                    </span>
                  </button>
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

export function KnowledgeLoadingSettings(props: {
  readonly metadata: ContextStoreContentMetadata;
  readonly onChange: (metadata: ContextStoreContentMetadata) => void;
}) {
  const { t } = useTranslation("studio");
  const descriptionId = useId();
  return (
    <div className="knowledge-metadata-form">
      <div className="knowledge-metadata-field">
        <KnowledgeMetadataHelp
          label={t("description")}
          labelFor={descriptionId}
          tips={[
            t("knowledgeLoadingHelp.descriptionPurpose"),
            t("knowledgeLoadingHelp.descriptionCaution"),
          ]}
        />
        <textarea
          id={descriptionId}
          value={props.metadata.description ?? ""}
          onChange={(event) =>
            props.onChange({ ...props.metadata, description: event.target.value })
          }
        />
      </div>
      <div className="knowledge-metadata-field">
        <KnowledgeMetadataHelp
          label={t("loadingBehavior")}
          tips={[
            t("knowledgeLoadingHelp.manual"),
            t("knowledgeLoadingHelp.modelDecision"),
            t("knowledgeLoadingHelp.alwaysOn"),
            t("knowledgeLoadingHelp.triggerCaution"),
          ]}
        />
        <SelectMenu<ContextStoreContentMetadata["trigger"]>
          ariaLabel={t("loadingBehavior")}
          className="form-select"
          value={props.metadata.trigger}
          options={[
            { value: "manual", label: t("onDemand") },
            { value: "model_decision", label: t("modelDecides") },
            { value: "always_on", label: t("loadImmediately") },
          ]}
          onChange={(trigger) => props.onChange({ ...props.metadata, trigger })}
        />
      </div>
      <div className="knowledge-metadata-field">
        <KnowledgeMetadataHelp
          label={t("priority")}
          tips={[
            t("knowledgeLoadingHelp.priorityPurpose"),
            t("knowledgeLoadingHelp.priorityCaution"),
          ]}
        />
        <SelectMenu<ContextStoreContentMetadata["priority"]>
          ariaLabel={t("priority")}
          className="form-select"
          value={props.metadata.priority}
          options={[
            { value: "low", label: t("priorityLow") },
            { value: "normal", label: t("priorityNormal") },
            { value: "high", label: t("priorityHigh") },
            { value: "critical", label: t("priorityCritical") },
          ]}
          onChange={(priority) => props.onChange({ ...props.metadata, priority })}
        />
      </div>
      <p>{t("frontmatterManaged")}</p>
    </div>
  );
}

function KnowledgeMetadataHelp(props: {
  readonly label: string;
  readonly labelFor?: string | undefined;
  readonly tips: readonly string[];
}) {
  const { t } = useTranslation("studio");
  const [open, setOpen] = useState(false);
  const tipId = useId();
  const helpLabel = t("knowledgeLoadingHelp.button", { setting: props.label });
  return (
    <div className="knowledge-metadata-help">
      <div className="knowledge-metadata-label">
        {props.labelFor === undefined ? (
          <span>{props.label}</span>
        ) : (
          <label htmlFor={props.labelFor}>{props.label}</label>
        )}
        <button
          type="button"
          className="knowledge-metadata-help-button"
          aria-label={helpLabel}
          title={helpLabel}
          aria-expanded={open}
          aria-controls={open ? tipId : undefined}
          onClick={() => setOpen((current) => !current)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setOpen(false);
            }
          }}
        >
          <Question size={16} aria-hidden="true" />
        </button>
      </div>
      {open ? (
        <div className="knowledge-metadata-tip" id={tipId}>
          {props.tips.map((tip) => (
            <p key={tip}>{tip}</p>
          ))}
        </div>
      ) : null}
    </div>
  );
}
