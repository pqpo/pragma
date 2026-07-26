import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import {
  CaretRight,
  GitBranch,
  MagnifyingGlass,
  Plus,
  Trash,
  UserCircle,
  UsersThree,
  X,
} from "@phosphor-icons/react";
import {
  PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH,
  PragmaExpertTeamResourceSchema,
  canonicalPragmaResourceRef,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaResource,
} from "@pragma/interpreter/ast";
import type {
  DesktopRuntimeAvailability,
  PragmaProjectSnapshot,
} from "../../../../shared/desktop-api.ts";

import { errorMessage } from "../../lib/errors.ts";
import { FlowEditor } from "./flow-editor/FlowEditor.tsx";
import { createEmptyFlow } from "./flow-editor/flow-model.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";
import { DeleteConfirmationDialog } from "./DeleteConfirmationDialog.tsx";

type ResourceKind = "team" | "flow";
type TeamExpertPickerKind = "coordinator" | "members";
type ResourceEditorMode = "create" | "edit";

const TEAM_EXPERT_RESULT_LIMIT = 8;

function unicodeLength(value: string): number {
  return [...value].length;
}

function expertRef(expert: PragmaExpertResource): string {
  return `expert:${expert.metadata.id}`;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function matchingTeamExperts(
  experts: readonly PragmaExpertResource[],
  query: string,
  selectedRefs: ReadonlySet<string>,
  excludedRef?: string | undefined,
  limit = TEAM_EXPERT_RESULT_LIMIT,
): readonly PragmaExpertResource[] {
  const term = normalized(query);
  return experts
    .filter((expert) => {
      const ref = expertRef(expert);
      if (ref === excludedRef) return false;
      return (
        term.length === 0 ||
        [
          expert.metadata.name,
          expert.metadata.id,
          expert.metadata.description,
          ...expert.metadata.tags,
          ref,
        ].some((value) => normalized(value).includes(term))
      );
    })
    .toSorted((left, right) => {
      const selectedOrder =
        Number(selectedRefs.has(expertRef(right))) - Number(selectedRefs.has(expertRef(left)));
      return selectedOrder || left.metadata.name.localeCompare(right.metadata.name);
    })
    .slice(0, limit);
}

export function PragmaResourceDirectoryFragment(props: {
  readonly kind: ResourceKind;
  readonly project: PragmaProjectSnapshot;
  readonly expertOptions: readonly { readonly ref: string; readonly name: string }[];
  readonly runtimes: readonly DesktopRuntimeAvailability[];
  readonly onProjectChanged: (snapshot: PragmaProjectSnapshot) => void;
}) {
  const { t } = useTranslation("studio");
  const [editing, setEditing] = useState<PragmaResource | "new" | null>(null);
  const [newResourceId, setNewResourceId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingRemoval, setPendingRemoval] = useState<PragmaResource | null>(null);
  const [deleting, setDeleting] = useState(false);
  const resources = props.project.resources.filter((resource) =>
    props.kind === "team" ? resource.kind === "ExpertTeam" : resource.kind === "Flow",
  );

  const save = async (
    resource: PragmaResource,
    expectedRevision: number,
    requiredUnchangedRefs: readonly string[],
  ): Promise<boolean> => {
    const api = desktopApi();
    if (api === undefined) return false;
    try {
      const snapshot = await api.upsertPragmaResource({
        baseRevision: expectedRevision,
        resource,
        requiredUnchangedRefs: [...requiredUnchangedRefs],
      });
      props.onProjectChanged(snapshot);
      setError(null);
      return true;
    } catch (saveError) {
      setError(errorMessage(saveError));
      return false;
    }
  };

  const saveFlow = async (
    resource: PragmaResource,
    supportingResources: readonly PragmaResource[],
    expectedRevision: number,
    requiredUnchangedRefs: readonly string[],
  ): Promise<boolean> => {
    const api = desktopApi();
    if (api === undefined) return false;
    try {
      const snapshot = await api.applyPragmaProjectChanges({
        baseRevision: expectedRevision,
        upserts: [...supportingResources, resource],
        removals: [],
        requiredUnchangedRefs: [...requiredUnchangedRefs],
      });
      props.onProjectChanged(snapshot);
      setError(null);
      return true;
    } catch (saveError) {
      setError(errorMessage(saveError));
      return false;
    }
  };

  const remove = async (resource: PragmaResource) => {
    const api = desktopApi();
    if (api === undefined) return;
    setDeleting(true);
    try {
      const snapshot = await api.deletePragmaResource({
        baseRevision: props.project.revision,
        ref: canonicalPragmaResourceRef(resource),
      });
      props.onProjectChanged(snapshot);
      if (resource.kind === "Flow") {
        await api.deleteWorkflowLayout({
          projectId: props.project.projectId,
          flowId: resource.metadata.id,
        });
      }
      setError(null);
      setPendingRemoval(null);
    } catch (removeError) {
      setError(errorMessage(removeError));
      setPendingRemoval(null);
    } finally {
      setDeleting(false);
    }
  };

  if (editing !== null) {
    const editorMode: ResourceEditorMode = editing === "new" ? "create" : "edit";
    const closeEditor = () => {
      setEditing(null);
      setNewResourceId(null);
    };
    return props.kind === "team" ? (
      <TeamEditor
        project={props.project}
        baseRevision={props.project.revision}
        mode={editorMode}
        newResourceId={newResourceId ?? undefined}
        initial={editing === "new" || editing.kind !== "ExpertTeam" ? undefined : editing}
        error={error}
        onCancel={closeEditor}
        onSave={async (resource, expectedRevision, requiredUnchangedRefs) => {
          if (await save(resource, expectedRevision, requiredUnchangedRefs)) closeEditor();
        }}
      />
    ) : (
      <FlowEditor
        project={props.project}
        expertOptions={props.expertOptions}
        baseRevision={props.project.revision}
        mode={editorMode}
        runtimes={props.runtimes}
        initial={
          editing === "new"
            ? newResourceId === null
              ? undefined
              : createEmptyFlow(newResourceId)
            : editing.kind === "Flow"
              ? editing
              : undefined
        }
        error={error}
        onCancel={closeEditor}
        onSave={saveFlow}
      />
    );
  }

  const Icon = props.kind === "team" ? UsersThree : GitBranch;
  const headingId = props.kind === "team" ? "expert-teams-heading" : "flows-heading";
  return (
    <StudioScreenFrame
      className="studio-collection pragma-resource-directory"
      labelledBy={headingId}
      header={
        <header className="studio-heading">
          <div>
            <h1 id={headingId}>{props.kind === "team" ? t("teams") : t("flows")}</h1>
            <p>{props.kind === "team" ? t("teamsDescription") : t("flowsDescription")}</p>
          </div>
          <button
            className="primary-button"
            type="button"
            onClick={() => {
              const api = desktopApi();
              if (api === undefined) return;
              void api
                .allocatePragmaResourceId()
                .then(({ id }) => {
                  setNewResourceId(id);
                  setEditing("new");
                })
                .catch((cause: unknown) => setError(errorMessage(cause)));
            }}
          >
            <Plus size={17} aria-hidden="true" />{" "}
            {t("newResource", { kind: props.kind === "team" ? t("expertTeam") : t("flow") })}
          </button>
        </header>
      }
    >
      <div className="studio-asset-rows">
        {resources.map((resource) => (
          <div
            className="studio-asset-row pragma-resource-row"
            key={canonicalPragmaResourceRef(resource)}
          >
            <span className="studio-asset-icon" aria-hidden="true">
              <Icon size={24} />
            </span>
            <button
              type="button"
              onClick={() => {
                setNewResourceId(null);
                setEditing(resource);
              }}
            >
              <strong>{resource.metadata.name}</strong>
              <span>{resource.metadata.description}</span>
            </button>
            <button
              className="pragma-resource-action pragma-resource-delete-action"
              type="button"
              aria-label={t("deleteNamed", { name: resource.metadata.name })}
              title={t("deleteResourceAction")}
              onClick={() => setPendingRemoval(resource)}
            >
              <Trash size={17} />
            </button>
          </div>
        ))}
        {resources.length === 0 ? (
          <p className="studio-empty-copy">
            {t("noResourcesYet", { kind: props.kind === "team" ? t("expertTeam") : t("flow") })}
          </p>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      {pendingRemoval !== null ? (
        <DeleteConfirmationDialog
          title={t("deleteResource", {
            kind: pendingRemoval.kind === "ExpertTeam" ? t("expertTeam") : t("flow"),
          })}
          description={t("deleteResourceDescription", { name: pendingRemoval.metadata.name })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteResourceAction")}
          deletingLabel={t("deleting")}
          busy={deleting}
          onCancel={() => setPendingRemoval(null)}
          onConfirm={() => void remove(pendingRemoval)}
        />
      ) : null}
    </StudioScreenFrame>
  );
}

export function TeamEditor(props: {
  readonly project: PragmaProjectSnapshot;
  readonly baseRevision?: number | undefined;
  readonly mode?: ResourceEditorMode | undefined;
  readonly newResourceId?: string | undefined;
  readonly initial?: PragmaExpertTeamResource | undefined;
  readonly error: string | null;
  readonly onCancel: () => void;
  readonly onSave: (
    resource: PragmaExpertTeamResource,
    expectedRevision: number,
    requiredUnchangedRefs: readonly string[],
  ) => Promise<void>;
}) {
  const { t } = useTranslation("studio");
  const experts = props.project.resources.filter(
    (resource): resource is PragmaExpertResource => resource.kind === "Expert",
  );
  const id = props.initial?.metadata.id ?? props.newResourceId ?? "";
  const [name, setName] = useState(props.initial?.metadata.name ?? "");
  const [description, setDescription] = useState(props.initial?.metadata.description ?? "");
  const [instructions, setInstructions] = useState(props.initial?.spec.instructions ?? "");
  const initialCoordinator = props.initial?.spec.coordinator.ref ?? "";
  const [coordinator, setCoordinator] = useState(initialCoordinator);
  const [members, setMembers] = useState<readonly string[]>(
    props.initial?.spec.members
      .map((member) => member.ref)
      .filter((ref) => ref !== initialCoordinator) ?? [],
  );
  const [maxConcurrency, setMaxConcurrency] = useState(
    props.initial?.spec.delegation.maxConcurrency ?? 4,
  );
  const [maxDepth, setMaxDepth] = useState(props.initial?.spec.delegation.maxDepth ?? 3);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [expectedRevision] = useState(props.baseRevision ?? props.project.revision);

  const submit = () => {
    try {
      const resource = PragmaExpertTeamResourceSchema.parse({
        apiVersion: "pragma/v3",
        kind: "ExpertTeam",
        metadata: { id, name, description, tags: props.initial?.metadata.tags ?? [] },
        spec: {
          coordinator: { ref: coordinator },
          members: members.map((ref) => ({ ref })),
          ...(instructions.trim() === "" ? {} : { instructions }),
          delegation: {
            maxConcurrency,
            maxDepth,
            context: props.initial?.spec.delegation.context ?? "context:pragma.context.fresh@v1",
            runtimes: props.initial?.spec.delegation.runtimes ?? {},
            allow: props.initial?.spec.delegation.allow,
          },
        },
      });
      setValidationError(null);
      void props.onSave(resource, expectedRevision, []);
    } catch (validationFailure) {
      setValidationError(errorMessage(validationFailure));
    }
  };

  return (
    <ResourceEditor
      title={props.mode === "create" ? t("newExpertTeam") : t("editExpertTeam")}
      error={validationError ?? props.error}
      onCancel={props.onCancel}
      onSave={submit}
    >
      <MetadataFields
        name={name}
        description={description}
        onName={setName}
        onDescription={setDescription}
      />
      <TeamExpertSelectors
        experts={experts}
        coordinator={coordinator}
        members={members}
        onCoordinatorChange={(ref) => {
          setCoordinator(ref);
          setMembers((current) => current.filter((memberRef) => memberRef !== ref));
        }}
        onMembersChange={setMembers}
      />
      <label>
        {t("teamInstructions")}
        <textarea
          className="team-instructions-input"
          rows={8}
          value={instructions}
          onChange={(event) => setInstructions(event.target.value)}
          maxLength={PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH * 2}
          placeholder={t("teamInstructionsPlaceholder")}
        />
        <span className="team-instructions-hint">
          <span>{t("teamInstructionsHint")}</span>
          <span>
            {unicodeLength(instructions)}/{PRAGMA_EXPERT_INSTRUCTIONS_MAX_LENGTH}
          </span>
        </span>
      </label>
      <div className="pragma-two-columns">
        <label>
          {t("maxConcurrency")}
          <input
            type="number"
            min={1}
            value={maxConcurrency}
            onChange={(event) => setMaxConcurrency(Number(event.target.value))}
          />
        </label>
        <label>
          {t("maxDelegationDepth")}
          <input
            type="number"
            min={1}
            value={maxDepth}
            onChange={(event) => setMaxDepth(Number(event.target.value))}
          />
        </label>
      </div>
    </ResourceEditor>
  );
}

function TeamExpertSelectors(props: {
  readonly experts: readonly PragmaExpertResource[];
  readonly coordinator: string;
  readonly members: readonly string[];
  readonly onCoordinatorChange: (ref: string) => void;
  readonly onMembersChange: (refs: readonly string[]) => void;
}) {
  const { t } = useTranslation("studio");
  const [activePicker, setActivePicker] = useState<TeamExpertPickerKind | null>(null);
  const [search, setSearch] = useState("");
  const coordinatorExpert = props.experts.find((expert) => expertRef(expert) === props.coordinator);
  const selectedMemberRefs = useMemo(() => new Set(props.members), [props.members]);
  const selectedMemberExperts = props.members.flatMap((ref) => {
    const expert = props.experts.find((candidate) => expertRef(candidate) === ref);
    return expert === undefined ? [] : [expert];
  });

  const closePicker = () => {
    setActivePicker(null);
    setSearch("");
  };

  useEffect(() => {
    if (activePicker === null) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePicker();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [activePicker]);

  const selectedRefs =
    activePicker === "coordinator"
      ? new Set(props.coordinator ? [props.coordinator] : [])
      : selectedMemberRefs;
  const excludedRef = activePicker === "members" ? props.coordinator : undefined;
  const visibleExperts =
    activePicker === null
      ? []
      : matchingTeamExperts(props.experts, search, selectedRefs, excludedRef);
  const matchingCount =
    activePicker === null
      ? 0
      : matchingTeamExperts(
          props.experts,
          search,
          selectedRefs,
          excludedRef,
          Number.MAX_SAFE_INTEGER,
        ).length;
  const activeSelectedCount =
    activePicker === "coordinator" ? Number(Boolean(props.coordinator)) : props.members.length;

  const openPicker = (picker: TeamExpertPickerKind) => {
    setSearch("");
    setActivePicker(picker);
  };

  return (
    <>
      <div className="team-expert-selectors">
        <section className="team-expert-selector" aria-labelledby="team-coordinator-label">
          <div className="team-expert-selector-heading">
            <div>
              <h3 id="team-coordinator-label">{t("coordinator")}</h3>
              <p>{t("coordinatorFieldDescription")}</p>
            </div>
          </div>
          <button
            className="team-expert-selector-trigger"
            type="button"
            aria-haspopup="dialog"
            onClick={() => openPicker("coordinator")}
          >
            <span className="team-expert-selector-icon" aria-hidden="true">
              <UserCircle size={21} />
            </span>
            <span className="team-expert-selector-value">
              <strong>{coordinatorExpert?.metadata.name ?? t("selectExpert")}</strong>
              <small>
                {coordinatorExpert === undefined
                  ? t("coordinatorEmptyDescription")
                  : `expert:${coordinatorExpert.metadata.id}`}
              </small>
            </span>
            <span className="team-expert-selector-action">
              {coordinatorExpert === undefined ? t("choose") : t("changeSelection")}
              <CaretRight size={16} aria-hidden="true" />
            </span>
          </button>
        </section>

        <section className="team-expert-selector" aria-labelledby="team-members-label">
          <div className="team-expert-selector-heading">
            <div>
              <h3 id="team-members-label">{t("members")}</h3>
              <p>{t("membersFieldDescription")}</p>
            </div>
            <span>{t("selectedCount", { count: props.members.length })}</span>
          </div>
          <button
            className="team-expert-selector-trigger"
            type="button"
            aria-haspopup="dialog"
            onClick={() => openPicker("members")}
          >
            <span className="team-expert-selector-icon" aria-hidden="true">
              <UsersThree size={21} />
            </span>
            <span className="team-expert-selector-value">
              <strong>
                {props.members.length === 0
                  ? t("selectTeamMembers")
                  : t("teamMembersSelected", { count: props.members.length })}
              </strong>
              <small>
                {selectedMemberExperts.length === 0
                  ? t("membersEmptyDescription")
                  : selectedMemberExperts
                      .slice(0, 3)
                      .map((expert) => expert.metadata.name)
                      .join(" · ")}
                {selectedMemberExperts.length > 3
                  ? ` · ${t("moreCount", { count: selectedMemberExperts.length - 3 })}`
                  : ""}
              </small>
            </span>
            <span className="team-expert-selector-action">
              {props.members.length === 0 ? t("choose") : t("editSelection")}
              <CaretRight size={16} aria-hidden="true" />
            </span>
          </button>
        </section>
      </div>

      {activePicker !== null ? (
        <div
          className="expert-picker-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) closePicker();
          }}
        >
          <aside
            className="expert-picker-dialog team-expert-picker-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="team-expert-picker-heading"
          >
            <header className="expert-picker-heading">
              <div>
                <small>{t("expertTeam")}</small>
                <h2 id="team-expert-picker-heading">
                  {activePicker === "coordinator" ? t("chooseCoordinator") : t("chooseTeamMembers")}
                </h2>
                <p>
                  {activePicker === "coordinator"
                    ? t("coordinatorPickerDescription")
                    : t("membersPickerDescription")}
                </p>
              </div>
              <button type="button" aria-label={t("closeExpertPicker")} onClick={closePicker}>
                <X size={19} aria-hidden="true" />
              </button>
            </header>
            <label className="expert-picker-search">
              <MagnifyingGlass size={18} aria-hidden="true" />
              <span className="sr-only">{t("searchExperts")}</span>
              <input
                autoFocus
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder={t("searchTeamExpertsDescription")}
              />
              {search ? (
                <button type="button" aria-label={t("clearSearch")} onClick={() => setSearch("")}>
                  <X size={16} aria-hidden="true" />
                </button>
              ) : null}
            </label>
            <div className="expert-picker-toolbar team-expert-picker-toolbar">
              <span>{t("selectedCount", { count: activeSelectedCount })}</span>
              <div>
                <span>
                  {t("showingMatching", {
                    visible: visibleExperts.length,
                    total: matchingCount,
                  })}
                </span>
                {activeSelectedCount > 0 ? (
                  <button
                    type="button"
                    onClick={() =>
                      activePicker === "coordinator"
                        ? props.onCoordinatorChange("")
                        : props.onMembersChange([])
                    }
                  >
                    {t("clearSelection")}
                  </button>
                ) : null}
              </div>
            </div>
            <div className="expert-picker-results">
              {visibleExperts.length > 0 ? (
                <div className="expert-picker-list">
                  {visibleExperts.map((expert) => {
                    const ref = expertRef(expert);
                    const selected = selectedRefs.has(ref);
                    return (
                      <label
                        className={`expert-picker-row${selected ? " is-selected" : ""}`}
                        key={ref}
                      >
                        <input
                          type={activePicker === "coordinator" ? "radio" : "checkbox"}
                          name={activePicker === "coordinator" ? "team-coordinator" : undefined}
                          checked={selected}
                          onChange={(event) => {
                            if (activePicker === "coordinator") {
                              props.onCoordinatorChange(ref);
                              return;
                            }
                            props.onMembersChange(
                              event.target.checked
                                ? [...props.members, ref]
                                : props.members.filter((memberRef) => memberRef !== ref),
                            );
                          }}
                        />
                        <span>
                          <strong>{expert.metadata.name}</strong>
                          <small>
                            {expert.metadata.description || `expert:${expert.metadata.id}`}
                          </small>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ) : (
                <div className="expert-picker-empty">
                  <strong>{search.trim() ? t("noMatchesFound") : t("noExpertsAvailable")}</strong>
                  <p>{search.trim() ? t("tryExpertSearch") : t("addExpertsFirst")}</p>
                </div>
              )}
              {matchingCount > visibleExperts.length ? (
                <p className="expert-plugin-result-hint">
                  {t("moreExpertsHidden", { count: matchingCount - visibleExperts.length })}
                </p>
              ) : null}
            </div>
            <footer className="expert-picker-actions">
              <span>
                {activePicker === "members"
                  ? t("coordinatorIncluded")
                  : t("selectionAppliedToTeam")}
              </span>
              <button className="primary-button" type="button" onClick={closePicker}>
                {t("common:actions.done")}
              </button>
            </footer>
          </aside>
        </div>
      ) : null}
    </>
  );
}

function ResourceEditor(props: {
  readonly title: string;
  readonly error: string | null;
  readonly children: ReactNode;
  readonly onCancel: () => void;
  readonly onSave: () => void;
  readonly saveDisabled?: boolean | undefined;
}) {
  const { t } = useTranslation("studio");
  return (
    <StudioScreenFrame
      className="pragma-resource-editor"
      labelledBy="resource-editor-heading"
      header={
        <header>
          <div>
            <h2 id="resource-editor-heading">{props.title}</h2>
            <p>{t("canonicalYaml")}</p>
          </div>
        </header>
      }
    >
      <div className="pragma-resource-form">{props.children}</div>
      {props.error ? (
        <p className="form-error" role="alert">
          {props.error}
        </p>
      ) : null}
      <footer>
        <button className="secondary-button" type="button" onClick={props.onCancel}>
          {t("cancel")}
        </button>
        <button
          className="studio-primary-action"
          type="button"
          onClick={props.onSave}
          disabled={props.saveDisabled}
        >
          {t("validatePublish")}
        </button>
      </footer>
    </StudioScreenFrame>
  );
}

function MetadataFields(props: {
  readonly name: string;
  readonly description: string;
  readonly onName: (value: string) => void;
  readonly onDescription: (value: string) => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <>
      <label>
        {t("name")}
        <input value={props.name} onChange={(event) => props.onName(event.target.value)} />
      </label>
      <label>
        {t("description")}
        <textarea
          rows={3}
          value={props.description}
          onChange={(event) => props.onDescription(event.target.value)}
        />
      </label>
    </>
  );
}
