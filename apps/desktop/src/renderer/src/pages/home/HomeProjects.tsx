import { useId, useRef, useState, type ReactNode } from "react";
import { Folder, GearSix, Plus, CaretDown } from "@phosphor-icons/react";
import { PRAGMA_TEXT_LIMITS } from "@pragma/shared";
import { useTranslation } from "react-i18next";
import {
  HomeProjectInputSchema,
  type HomeProject,
  type SaveHomeProject,
} from "../../../../shared/contracts/home-projects.ts";
import type {
  ContextStore,
  HomeMissionExecutorOption,
} from "../../../../shared/contracts/index.ts";
import { CharacterCount } from "../../components/CharacterCount.tsx";
import { Dialog, ConfirmationDialog } from "../../components/Dialog.tsx";
import { ContextStorePickerDialog } from "../../components/ContextStorePickerDialog.tsx";
import { WorkspacePicker, type WorkspaceSelection } from "../../components/WorkspacePicker.tsx";
import { errorMessage } from "../../lib/errors.ts";

export function HomeProjects(props: {
  projects: readonly HomeProject[];
  executors: readonly HomeMissionExecutorOption[];
  stores: readonly ContextStore[];
  selectedId: string | undefined;
  onSelect: (project: HomeProject) => void;
  onEdit: (project: HomeProject | null) => void;
  onMore?: () => void;
  showEditActions?: boolean;
  disabled?: boolean;
}) {
  const { t } = useTranslation("missions");
  if (props.projects.length === 0)
    return (
      <div className="home-project-empty">
        <p>{t("homeProjectsEmpty")}</p>
        <button
          type="button"
          className="text-button"
          disabled={props.disabled}
          onClick={() => props.onEdit(null)}
        >
          <Plus size={16} />
          {t("homeProjectCreate")}
        </button>
      </div>
    );
  return (
    <div className="home-project-list">
      {(props.onMore ? props.projects.slice(0, 6) : props.projects).map((project) => {
        const unavailable =
          !props.executors.some((item) => item.ref === project.executorRef) ||
          project.contextStoreIds.some((id) => !props.stores.some((store) => store.id === id));
        return (
          <div className="home-project-item" key={project.id}>
            <button
              type="button"
              className={`home-project-button${props.selectedId === project.id ? " is-active" : ""}`}
              disabled={props.disabled}
              aria-pressed={props.selectedId === project.id}
              onClick={() => props.onSelect(project)}
              title={project.workspace.path}
            >
              <Folder size={20} aria-hidden="true" />
              <span className="home-favorite-copy">
                <strong>{project.name}</strong>
                <small>
                  {unavailable ? t("homeProjectUnavailable") : project.workspace.basename}
                </small>
              </span>
            </button>
            {props.showEditActions ? (
              <button
                className="home-favorites-manage-button"
                type="button"
                title={t("homeProjectEditNamed", { name: project.name })}
                aria-label={t("homeProjectEditNamed", { name: project.name })}
                disabled={props.disabled}
                onClick={() => props.onEdit(project)}
              >
                <GearSix size={16} />
              </button>
            ) : null}
          </div>
        );
      })}
      {props.onMore && props.projects.length > 6 ? (
        <button type="button" className="text-button home-project-more" onClick={props.onMore}>
          {t("homeFavoritesMore", { count: props.projects.length - 6 })}
        </button>
      ) : null}
    </div>
  );
}

export function HomeProjectEditor(props: {
  project: HomeProject | null;
  executors: readonly HomeMissionExecutorOption[];
  stores: readonly ContextStore[];
  defaultWorkspace: WorkspaceSelection | undefined;
  recentWorkspaces: readonly WorkspaceSelection[];
  renderExecutorPicker: (
    value: string,
    onChange: (value: string) => void,
    workspace: WorkspaceSelection | undefined,
  ) => ReactNode;
  onSave: (input: SaveHomeProject) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation("missions");
  const { t: common } = useTranslation("common");
  const nameId = useId();
  const errorId = useId();
  const nameRef = useRef<HTMLInputElement>(null);
  const executorFieldRef = useRef<HTMLDivElement>(null);
  const knowledgeFieldRef = useRef<HTMLDivElement>(null);
  const workspaceFieldRef = useRef<HTMLDivElement>(null);
  const [name, setName] = useState(props.project?.name ?? "");
  const [executorRef, setExecutorRef] = useState(props.project?.executorRef ?? "");
  const [workspace, setWorkspace] = useState(props.project?.workspace);
  const [storeIds, setStoreIds] = useState(props.project?.contextStoreIds ?? []);
  const [error, setError] = useState<string>();
  const [attempted, setAttempted] = useState(false);
  const operationPending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [knowledgePickerOpen, setKnowledgePickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const input = { name, executorRef, workspace, contextStoreIds: storeIds };
  const nameInvalid = !HomeProjectInputSchema.shape.name.safeParse(name).success;
  const missingExecutor = !props.executors.some((executor) => executor.ref === executorRef);
  const missingStoreIds = storeIds.filter((id) => !props.stores.some((store) => store.id === id));
  const missingBinding = missingExecutor || missingStoreIds.length > 0;
  const chooseWorkspace = async () => {
    if (operationPending.current) return;
    operationPending.current = true;
    setBusy(true);
    try {
      const result = await window.pragmaDesktop.pickWorkspace();
      if (result.ok && result.path && result.basename)
        setWorkspace({ path: result.path, basename: result.basename });
      else if (result.reason !== "cancelled") setError(result.error ?? t("workspaceUnavailable"));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };
  const save = async () => {
    if (operationPending.current) return;
    setAttempted(true);
    const parsed = HomeProjectInputSchema.safeParse(input);
    if (!parsed.success || missingBinding) {
      setError(t("homeProjectRequired"));
      if (nameInvalid) nameRef.current?.focus();
      else if (!props.executors.some((executor) => executor.ref === executorRef))
        executorFieldRef.current?.querySelector<HTMLElement>("button")?.focus();
      else if (!workspace)
        workspaceFieldRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      else if (missingStoreIds.length > 0)
        knowledgeFieldRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
      return;
    }
    operationPending.current = true;
    setBusy(true);
    setError(undefined);
    try {
      const validation = await window.pragmaDesktop.validateWorkspace(parsed.data.workspace.path);
      if (!validation.ok) throw new Error(t("workspaceUnavailable"));
      await props.onSave({ ...parsed.data, ...(props.project ? { id: props.project.id } : {}) });
      props.onClose();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      operationPending.current = false;
      setBusy(false);
    }
  };
  return (
    <>
      <Dialog
        title={props.project ? t("homeProjectEdit") : t("homeProjectCreate")}
        description={t("homeProjectDescription")}
        className="home-project-dialog"
        busy={busy || knowledgePickerOpen || confirmDelete}
        onCancel={props.onClose}
        footer={
          <>
            {props.project ? (
              <button
                type="button"
                className="text-button home-project-delete"
                disabled={busy}
                onClick={() => setConfirmDelete(true)}
              >
                {common("actions.delete")}
              </button>
            ) : null}
            <button
              type="button"
              className="secondary-button"
              disabled={busy}
              onClick={props.onClose}
            >
              {common("actions.cancel")}
            </button>
            <button
              type="button"
              className="primary-button"
              disabled={busy}
              onClick={() => void save()}
            >
              {common("actions.save")}
            </button>
          </>
        }
      >
        <fieldset className="home-project-fields" disabled={busy || confirmDelete}>
          <div className="home-project-field">
            <label htmlFor={nameId}>{t("homeProjectName")}</label>
            <input
              id={nameId}
              ref={nameRef}
              value={name}
              aria-invalid={attempted && nameInvalid}
              aria-describedby={attempted && nameInvalid ? errorId : undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(undefined);
              }}
            />
            <CharacterCount value={name} max={PRAGMA_TEXT_LIMITS.defaultMetadata.name} />
          </div>
          <div className="home-workspace-context home-project-bindings">
            <div
              className="home-project-field"
              ref={executorFieldRef}
              aria-describedby={attempted && missingExecutor ? errorId : undefined}
            >
              <span>{t("homeProjectExecutor")}</span>
              {props.renderExecutorPicker(
                executorRef,
                (value) => {
                  setExecutorRef(value);
                  setError(undefined);
                },
                workspace,
              )}
            </div>
            <div
              className="home-project-field"
              ref={workspaceFieldRef}
              aria-describedby={attempted && !workspace ? errorId : undefined}
            >
              <span>{t("taskWorkspace")}</span>
              <WorkspacePicker
                defaultWorkspace={props.defaultWorkspace}
                recentWorkspaces={props.recentWorkspaces}
                selection={workspace}
                chooseDescription={t("homeProjectChooseWorkspace")}
                unselected={workspace === undefined}
                defaultSelected={
                  workspace !== undefined && workspace.path === props.defaultWorkspace?.path
                }
                onChoose={() => void chooseWorkspace()}
                onSelect={setWorkspace}
                onUseDefault={() => setWorkspace(props.defaultWorkspace)}
              />
            </div>
          </div>
          <div
            className="home-project-field"
            ref={knowledgeFieldRef}
            aria-describedby={attempted && missingStoreIds.length > 0 ? errorId : undefined}
          >
            <span>{t("homeProjectKnowledge")}</span>
            <button
              type="button"
              className="home-project-knowledge-trigger"
              onClick={() => setKnowledgePickerOpen(true)}
              aria-haspopup="dialog"
            >
              <Folder size={18} aria-hidden="true" />
              <span>{t("homeProjectKnowledgeSelection", { count: storeIds.length })}</span>
              <CaretDown size={16} aria-hidden="true" />
            </button>
            {missingStoreIds.length > 0 ? (
              <button
                type="button"
                className="text-button"
                onClick={() => {
                  setStoreIds((ids) => ids.filter((id) => !missingStoreIds.includes(id)));
                  setError(undefined);
                }}
              >
                {t("homeProjectRemoveUnavailableKnowledge", { count: missingStoreIds.length })}
              </button>
            ) : null}
            <p className="home-project-hint">
              {storeIds.length === 0
                ? t("homeProjectKnowledgeHint")
                : storeIds
                    .slice(0, 2)
                    .map(
                      (id) =>
                        props.stores.find((store) => store.id === id)?.name ??
                        t("homeProjectUnavailable"),
                    )
                    .join(" · ")}
            </p>
          </div>
          {error ? (
            <p id={errorId} className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </fieldset>
      </Dialog>
      {knowledgePickerOpen ? (
        <ContextStorePickerDialog
          stores={props.stores}
          selectedStoreIds={storeIds}
          description={t("homeProjectKnowledgeHint")}
          footerHint={t("homeProjectDescription")}
          onSelectedStoreIdsChange={(ids) => {
            setStoreIds([...ids]);
            setError(undefined);
          }}
          onClose={() => setKnowledgePickerOpen(false)}
        />
      ) : null}
      {confirmDelete && props.project ? (
        <ConfirmationDialog
          title={t("homeProjectDelete")}
          description={t("homeProjectDeleteDescription", { name: props.project.name })}
          cancelLabel={common("actions.cancel")}
          confirmLabel={common("actions.delete")}
          busyLabel={common("actions.delete")}
          busy={busy}
          onCancel={() => setConfirmDelete(false)}
          onConfirm={() => {
            if (operationPending.current) return;
            operationPending.current = true;
            setBusy(true);
            void props
              .onDelete(props.project!.id)
              .then(props.onClose)
              .catch((cause: unknown) => {
                setConfirmDelete(false);
                setError(errorMessage(cause));
              })
              .finally(() => {
                operationPending.current = false;
                setBusy(false);
              });
          }}
        />
      ) : null}
    </>
  );
}
