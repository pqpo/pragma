import { FileText, SpinnerGap } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type {
  Capability,
  ContextStoreEntry,
  SkillFileContent,
  SkillFileEntry,
  SkillFileOperation,
} from "../../../../shared/contracts/index.ts";
import { Dialog } from "../../components/Dialog.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { SIDEBAR_WIDTH_PREFERENCES } from "../../lib/sidebar-width-preference.ts";
import { AssetFileWorkspace } from "./AssetFileWorkspace.tsx";
import { parentId, rebaseEntryId } from "./asset-file-paths.ts";
import type { StudioLeaveGuard } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

export function skillFileTreeEntries(files: readonly SkillFileEntry[]): ContextStoreEntry[] {
  const entries = new Map<string, ContextStoreEntry>();
  for (const file of files) {
    const segments = file.path.split("/");
    for (let depth = 1; depth < segments.length; depth++) {
      const id = segments.slice(0, depth).join("/");
      entries.set(id, { id, kind: "directory" });
    }
    entries.set(file.path, { id: file.path, kind: file.kind ?? "file" });
  }
  return [...entries.values()].toSorted((left, right) => left.id.localeCompare(right.id));
}

export function skillPreviewBody(path: string, content: string): string {
  if (path !== "SKILL.md") return content;
  return content
    .replace(/^\uFEFF/u, "")
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/u, "")
    .trimStart();
}

export type SkillSaveAction = {
  readonly dirty: boolean;
  readonly saving: boolean;
  readonly save: () => Promise<boolean>;
};

export function SkillFileWorkspace(props: {
  readonly onSaveActionChange: (action: SkillSaveAction | null) => void;
  readonly capability: Capability;
  readonly onChanged: (capability: Capability) => void;
  readonly onLeaveGuardChange: (guard: StudioLeaveGuard | null) => void;
}) {
  const { t } = useTranslation("studio");
  const readOnly = props.capability.managedBy === "system";
  const [files, setFiles] = useState<readonly SkillFileEntry[]>([]);
  const [selectedEntry, setSelectedEntry] = useState<ContextStoreEntry | null>(null);
  const [operations, setOperations] = useState<readonly SkillFileOperation[]>([]);
  const operationsRef = useRef(operations);
  operationsRef.current = operations;
  const originsRef = useRef(new Map<string, string>());
  const [selected, setSelected] = useState<SkillFileContent | null>(null);
  const [edits, setEdits] = useState<ReadonlyMap<string, string>>(new Map());
  const editsRef = useRef(edits);
  editsRef.current = edits;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [preview, setPreview] = useState(true);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const savingRef = useRef(false);
  const [saved, setSaved] = useState(false);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [leaveAction, setLeaveAction] = useState<(() => void) | null>(null);
  const requestRef = useRef(0);
  const selectionRef = useRef<string>("SKILL.md");
  const loadedRevisionRef = useRef(props.capability.manifest.latestRevision);
  const id = props.capability.manifest.id;
  const revision = props.capability.manifest.latestRevision;

  const readFile = useCallback(
    async (path: string, fileRevision: number) => {
      const api = desktopApi();
      if (api === undefined) return;
      const request = ++requestRef.current;
      selectionRef.current = path;
      setSelectedEntry({ id: path, kind: "file" });
      setSelected(null);
      const staged = editsRef.current.get(path);
      const originalPath = originsRef.current.get(path);
      if (originalPath === undefined && staged !== undefined) {
        setSelected({
          capabilityId: id,
          revision: fileRevision,
          path,
          size: new TextEncoder().encode(staged).byteLength,
          content: "",
        });
        setLoading(false);
        return;
      }
      setLoading(true);
      try {
        const content = await api.getSkillFile({
          id,
          revision: fileRevision,
          path: originalPath ?? path,
        });
        if (request !== requestRef.current) return;
        setSelected({ ...content, path });
        setError(null);
      } catch (cause) {
        if (request === requestRef.current) setError(errorMessage(cause));
      } finally {
        if (request === requestRef.current) setLoading(false);
      }
    },
    [id],
  );

  useEffect(() => {
    const api = desktopApi();
    if (api === undefined) return;
    if (editsRef.current.size > 0 || operationsRef.current.length > 0) {
      if (loadedRevisionRef.current !== revision) setError(t("skillEditConflict"));
      return;
    }
    let cancelled = false;
    loadedRevisionRef.current = revision;
    setLoading(true);
    setSelected(null);
    setFiles([]);
    void api
      .listSkillFiles({ id, revision, includeDirectories: true })
      .then(async (next) => {
        if (cancelled) return;
        setFiles(next);
        originsRef.current = new Map(
          next.filter((file) => file.kind !== "directory").map((file) => [file.path, file.path]),
        );
        const path = next.some(
          (file) => file.kind !== "directory" && file.path === selectionRef.current,
        )
          ? selectionRef.current
          : "SKILL.md";
        await readFile(path, revision);
      })
      .catch((cause: unknown) => {
        if (!cancelled) {
          setError(errorMessage(cause));
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
      requestRef.current++;
    };
  }, [id, revision, readFile, reloadVersion, t]);

  const save = useCallback(async (): Promise<boolean> => {
    const api = desktopApi();
    if (api === undefined || readOnly || savingRef.current) return false;
    const pending = editsRef.current;
    if (pending.size === 0 && operationsRef.current.length === 0) return true;
    savingRef.current = true;
    setSaving(true);
    setError(null);
    try {
      const capability = await api.saveSkillFiles({
        id,
        baseRevision: loadedRevisionRef.current,
        files: [...pending].map(([path, content]) => ({ path, content })),
        operations: [...operationsRef.current],
      });
      editsRef.current = new Map();
      setEdits(new Map());
      operationsRef.current = [];
      setOperations([]);
      setSaved(true);
      props.onChanged(capability);
      setReloadVersion((current) => current + 1);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  }, [id, props.onChanged, readOnly]);

  const requestLeave = useCallback<StudioLeaveGuard>((action) => {
    if (savingRef.current) return;
    if (editsRef.current.size === 0 && operationsRef.current.length === 0) action();
    else setLeaveAction(() => action);
  }, []);
  useEffect(() => {
    props.onLeaveGuardChange(requestLeave);
    return () => props.onLeaveGuardChange(null);
  }, [props.onLeaveGuardChange, requestLeave]);
  useEffect(() => {
    if (readOnly) return;
    const handleSave = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", handleSave);
    return () => window.removeEventListener("keydown", handleSave);
  }, [readOnly, save]);
  useEffect(() => {
    if (edits.size === 0 && operations.length === 0) return;
    const preventUnload = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener("beforeunload", preventUnload);
    return () => window.removeEventListener("beforeunload", preventUnload);
  }, [edits.size, operations.length]);

  const entries = useMemo(() => skillFileTreeEntries(files), [files]);
  const value = selected === null ? null : (edits.get(selected.path) ?? selected.content);
  const dirty = edits.size > 0 || operations.length > 0;
  useEffect(() => {
    props.onSaveActionChange(readOnly ? null : { dirty, saving, save });
    return () => props.onSaveActionChange(null);
  }, [dirty, saving, save, readOnly, props.onSaveActionChange]);
  const recordOperation = (operation: SkillFileOperation) => {
    operationsRef.current = [...operationsRef.current, operation];
    setOperations(operationsRef.current);
    setSaved(false);
  };
  const ensureAvailable = (path: string) => {
    if (entries.some((entry) => entry.id === path)) throw new Error(t("fileEntryAlreadyExists"));
  };
  const renameEntry = async (entry: ContextStoreEntry, nextId: string) => {
    if (entry.id === nextId) return;
    ensureAvailable(nextId);
    recordOperation({ kind: "move", path: entry.id, nextPath: nextId });
    setFiles((current) =>
      current.map((file) => ({
        ...file,
        path: rebaseEntryId(file.path, entry.id, nextId) ?? file.path,
      })),
    );
    const nextEdits = new Map(
      [...editsRef.current].map(([path, content]) => [
        rebaseEntryId(path, entry.id, nextId) ?? path,
        content,
      ]),
    );
    editsRef.current = nextEdits;
    setEdits(nextEdits);
    originsRef.current = new Map(
      [...originsRef.current].map(([path, origin]) => [
        rebaseEntryId(path, entry.id, nextId) ?? path,
        origin,
      ]),
    );
    setCollapsed(
      (current) =>
        new Set([...current].map((path) => rebaseEntryId(path, entry.id, nextId) ?? path)),
    );
    const nextSelection =
      selectedEntry === null ? undefined : rebaseEntryId(selectedEntry.id, entry.id, nextId);
    if (nextSelection !== undefined) {
      requestRef.current++;
      selectionRef.current = selectedEntry?.kind === "file" ? nextSelection : "SKILL.md";
      setSelectedEntry((current) => (current === null ? null : { ...current, id: nextSelection }));
      setSelected((current) => (current === null ? null : { ...current, path: nextSelection }));
    }
  };
  const refresh = async () => {
    if (dirty) throw new Error(t("saveSkillBeforeRefresh"));
    const api = desktopApi();
    if (api === undefined) return;
    const nextCapability = await api.getCapability(id);
    if (nextCapability.manifest.latestRevision !== revision) {
      props.onChanged(nextCapability);
      return;
    }
    const next = await api.listSkillFiles({ id, revision, includeDirectories: true });
    setFiles(next);
    originsRef.current = new Map(
      next.filter((file) => file.kind !== "directory").map((file) => [file.path, file.path]),
    );
    if (selectedEntry?.kind === "file") await readFile(selectedEntry.id, revision);
  };
  return (
    <div className="skill-workspace">
      <AssetFileWorkspace
        className="skill-file-workspace"
        filesLabel={t("skillFiles")}
        resizeLabel={t("resizeSkillFileList")}
        widthPreference={SIDEBAR_WIDTH_PREFERENCES.skillFiles}
        entries={entries}
        selectedEntry={selectedEntry}
        collapsedDirectoryIds={collapsed}
        loading={loading}
        disabled={saving || loading}
        deleteEntryDescription={(entry) => t("deleteSkillEntryConfirm", { name: entry.id })}
        onRefresh={refresh}
        onOpenEntry={(entry) => {
          if (savingRef.current) return;
          if (entry.kind === "directory") {
            requestRef.current++;
            setSelectedEntry(entry);
            setSelected(null);
            setLoading(false);
            setCollapsed((current) => {
              const next = new Set(current);
              if (next.has(entry.id)) next.delete(entry.id);
              else next.add(entry.id);
              return next;
            });
          } else void readFile(entry.id, loadedRevisionRef.current);
        }}
        operations={
          readOnly
            ? undefined
            : {
                canModifyEntry: (entry) => entry.id !== "SKILL.md" && !saving && !loading,
                createFile: async (path, copy) => {
                  ensureAvailable(path);
                  const content = copy ? (value ?? "") : "";
                  recordOperation({ kind: "create-file", path });
                  setFiles((current) => [...current, { path, size: 0 }]);
                  const next = new Map(editsRef.current).set(path, content);
                  editsRef.current = next;
                  setEdits(next);
                  setSaved(false);
                  requestRef.current++;
                  selectionRef.current = path;
                  setSelectedEntry({ id: path, kind: "file" });
                  setSelected({ capabilityId: id, revision, path, size: 0, content: "" });
                  setCollapsed((current) => {
                    const next = new Set(current);
                    next.delete(parentId(path));
                    return next;
                  });
                  setPreview(false);
                },
                createFolder: async (path) => {
                  ensureAvailable(path);
                  recordOperation({ kind: "create-directory", path });
                  setFiles((current) => [...current, { path, kind: "directory", size: 0 }]);
                },
                renameEntry,
                deleteEntry: async (entry) => {
                  recordOperation({ kind: "delete", path: entry.id });
                  const isRemoved = (path: string) =>
                    path === entry.id || path.startsWith(`${entry.id}/`);
                  setFiles((current) => current.filter((file) => !isRemoved(file.path)));
                  const next = new Map([...editsRef.current].filter(([path]) => !isRemoved(path)));
                  editsRef.current = next;
                  setEdits(next);
                  originsRef.current = new Map(
                    [...originsRef.current].filter(([path]) => !isRemoved(path)),
                  );
                  if (selectedEntry !== null && isRemoved(selectedEntry.id)) {
                    requestRef.current++;
                    selectionRef.current = "SKILL.md";
                    setSelectedEntry(null);
                    setSelected(null);
                  }
                },
              }
        }
        emptyEditor={
          <>
            {loading ? <SpinnerGap size={24} className="spin" /> : <FileText size={32} />}
            <p>{loading ? t("loadingSkillFile") : t("selectSkillFile")}</p>
          </>
        }
        editor={
          selected === null
            ? null
            : {
                path: selected.path,
                value,
                preview,
                previewSource: value === null ? "" : skillPreviewBody(selected.path, value),
                onPreviewChange: setPreview,
                readOnly,
                disabled: saving,
                status: (
                  <span className="knowledge-save-status">
                    {saving
                      ? t("saving")
                      : saved
                        ? t("saved")
                        : dirty
                          ? t("skillUnsavedChanges")
                          : ""}
                  </span>
                ),
                onChange: (content) => {
                  setSaved(false);
                  const next = new Map(editsRef.current);
                  if (content === selected.content && originsRef.current.has(selected.path))
                    next.delete(selected.path);
                  else next.set(selected.path, content);
                  editsRef.current = next;
                  setEdits(next);
                },
              }
        }
      />
      {error === null ? null : (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {leaveAction === null ? null : (
        <Dialog
          title={t("unsavedKnowledgeChangesTitle")}
          description={t("unsavedSkillChangesDescription")}
          busy={saving}
          onCancel={() => setLeaveAction(null)}
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={saving}
                onClick={() => setLeaveAction(null)}
              >
                {t("cancel")}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={saving}
                onClick={() => {
                  editsRef.current = new Map();
                  setEdits(new Map());
                  operationsRef.current = [];
                  setOperations([]);
                  requestRef.current++;
                  selectionRef.current = "SKILL.md";
                  originsRef.current = new Map();
                  setSelectedEntry(null);
                  setSelected(null);
                  setFiles([]);
                  setCollapsed(new Set());
                  setSaved(false);
                  setError(null);
                  setReloadVersion((current) => current + 1);
                  setLeaveAction(null);
                  leaveAction();
                }}
              >
                {t("discardAndLeave")}
              </button>
              <button
                className="primary-button"
                type="button"
                disabled={saving}
                onClick={() => {
                  void save().then((ok) => {
                    if (ok) {
                      setLeaveAction(null);
                      leaveAction();
                    }
                  });
                }}
              >
                {t("saveAndLeave")}
              </button>
            </>
          }
        >
          {error === null ? null : (
            <p className="form-error" role="alert">
              {error}
            </p>
          )}
        </Dialog>
      )}
    </div>
  );
}
