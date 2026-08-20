import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  DotsThree,
  Flask,
  GitBranch,
  MagnifyingGlass,
  Plus,
  Trash,
  User,
  UsersThree,
} from "@phosphor-icons/react";
import {
  PragmaFlowRunDryEvaluationResourceSchema,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaFlowResource,
  type PragmaFlowRunDryEvaluationResource,
} from "@pragma/interpreter/ast";

import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { SidebarResizeHandle } from "../../components/SidebarResizeHandle.tsx";
import {
  SIDEBAR_WIDTH_PREFERENCES,
  usePersistentSidebarWidth,
} from "../../lib/sidebar-width-preference.ts";
import { StudioConfirmationDialog } from "../studio/StudioDialog.tsx";
import { desktopApi } from "../studio/studio-model.ts";

type EvaluationTarget = PragmaExpertResource | PragmaExpertTeamResource | PragmaFlowResource;
type EvaluationTargetKind = EvaluationTarget["kind"];

const visibleTargetLimit = 4;

export function activateEvaluationDirectory(mounted: { current: boolean }): () => void {
  mounted.current = true;

  return () => {
    mounted.current = false;
  };
}

export function evaluationsForTarget(
  evaluations: readonly PragmaFlowRunDryEvaluationResource[],
  target: EvaluationTarget | null,
): readonly PragmaFlowRunDryEvaluationResource[] {
  if (target?.kind !== "Flow") return [];
  const targetRef = `flow:${target.metadata.id}`;
  return evaluations.filter((evaluation) => evaluation.spec.target.ref === targetRef);
}

export function defaultEvaluationTargetId(
  experts: readonly PragmaExpertResource[],
  teams: readonly PragmaExpertTeamResource[],
  flows: readonly PragmaFlowResource[],
): string {
  return experts[0]?.metadata.id ?? teams[0]?.metadata.id ?? flows[0]?.metadata.id ?? "";
}

export function EvaluationDirectoryFragment(props: {
  readonly project: PragmaProjectSnapshot;
  readonly onOpen: (evaluation: PragmaFlowRunDryEvaluationResource) => void;
  readonly onCreate: (resourceId: string, flow: PragmaFlowResource) => void;
  readonly onCreateAgentEvaluation?:
    ((target: PragmaExpertResource | PragmaExpertTeamResource) => void) | undefined;
  readonly onOpenDatasets?: (() => void) | undefined;
  readonly onOpenQueue?: (() => void) | undefined;
  readonly focusAction?: "datasets" | "queue" | null | undefined;
  readonly onFocusActionHandled?: (() => void) | undefined;
  readonly onDelete: (evaluation: PragmaFlowRunDryEvaluationResource) => Promise<void>;
  readonly onSelectTarget?: ((target: EvaluationTarget) => void) | undefined;
  readonly selectedTargetId: string;
  readonly onSelectedTargetIdChange: (targetId: string) => void;
  readonly detail?: ReactNode | undefined;
  readonly detailLabelledBy?: string | undefined;
}) {
  const { t, i18n } = useTranslation("studio");
  const { onSelectedTargetIdChange } = props;
  const [navigationWidth, setNavigationWidth] = usePersistentSidebarWidth(
    SIDEBAR_WIDTH_PREFERENCES.evaluations,
  );
  const [error, setError] = useState<string | null>(null);
  const [allocating, setAllocating] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<PragmaFlowRunDryEvaluationResource | null>(
    null,
  );
  const [search, setSearch] = useState("");
  const [expandedKinds, setExpandedKinds] = useState<ReadonlySet<EvaluationTargetKind>>(new Set());
  const datasetsButtonRef = useRef<HTMLButtonElement>(null);
  const queueButtonRef = useRef<HTMLButtonElement>(null);
  const mountedRef = useRef(false);
  useEffect(() => activateEvaluationDirectory(mountedRef), []);
  useEffect(() => {
    if (props.detail !== undefined || props.focusAction == null) return;
    const target =
      props.focusAction === "datasets" ? datasetsButtonRef.current : queueButtonRef.current;
    if (target === null) return;
    target.focus();
    props.onFocusActionHandled?.();
  }, [props.detail, props.focusAction, props.onFocusActionHandled]);

  const { evaluations, agentDatasetCount, experts, teams, flows, targets, defaultTargetId } =
    useMemo(() => {
      const evaluations: PragmaFlowRunDryEvaluationResource[] = [];
      const experts: PragmaExpertResource[] = [];
      const teams: PragmaExpertTeamResource[] = [];
      const flows: PragmaFlowResource[] = [];
      const targets: EvaluationTarget[] = [];
      let agentDatasetCount = 0;
      for (const resource of props.project.resources) {
        if (
          resource.kind === "Evaluation" &&
          "target" in resource.spec &&
          resource.spec.method.type === "flow-run-dry"
        ) {
          evaluations.push(PragmaFlowRunDryEvaluationResourceSchema.parse(resource));
          continue;
        }
        if (resource.kind === "Evaluation" && resource.spec.method.type === "agent-judge") {
          agentDatasetCount += 1;
          continue;
        }
        if (resource.kind === "Expert") experts.push(resource);
        else if (resource.kind === "ExpertTeam") teams.push(resource);
        else if (resource.kind === "Flow") flows.push(resource);
        else continue;
        targets.push(resource);
      }
      const defaultTargetId = defaultEvaluationTargetId(experts, teams, flows);
      return { evaluations, agentDatasetCount, experts, teams, flows, targets, defaultTargetId };
    }, [props.project.resources]);
  const selectedTarget =
    targets.find((target) => target.metadata.id === props.selectedTargetId) ?? null;

  useEffect(() => {
    if (selectedTarget === null && defaultTargetId !== "") {
      onSelectedTargetIdChange(defaultTargetId);
    }
  }, [defaultTargetId, onSelectedTargetIdChange, selectedTarget]);

  const targetEvaluations = evaluationsForTarget(evaluations, selectedTarget);
  const groups: readonly {
    readonly kind: EvaluationTargetKind;
    readonly label: string;
    readonly icon: typeof User;
    readonly resources: readonly EvaluationTarget[];
  }[] = [
    {
      kind: "Expert",
      label: t("expertSingular"),
      icon: User,
      resources: experts,
    },
    {
      kind: "ExpertTeam",
      label: t("teamSingular"),
      icon: UsersThree,
      resources: teams,
    },
    {
      kind: "Flow",
      label: t("flowSingular"),
      icon: GitBranch,
      resources: flows,
    },
  ];
  const normalizedSearch = search.trim().toLocaleLowerCase(i18n.language);

  const createEvaluation = () => {
    if (selectedTarget?.kind === "Expert" || selectedTarget?.kind === "ExpertTeam") {
      props.onCreateAgentEvaluation?.(selectedTarget);
      return;
    }
    const api = desktopApi();
    if (api === undefined || selectedTarget?.kind !== "Flow" || allocating) return;
    setAllocating(true);
    setError(null);
    void api
      .allocatePragmaResourceId()
      .then(({ id }) => {
        if (!mountedRef.current) return;
        setAllocating(false);
        props.onCreate(id, selectedTarget);
      })
      .catch((cause: unknown) => {
        if (!mountedRef.current) return;
        setAllocating(false);
        setError(errorMessage(cause));
      });
  };

  const deleteEvaluation = async () => {
    if (pendingDelete === null || deleting) return;
    const evaluation = pendingDelete;
    setDeleting(true);
    setError(null);
    try {
      await props.onDelete(evaluation);
      if (!mountedRef.current) return;
      setPendingDelete(null);
    } catch (cause) {
      if (!mountedRef.current) return;
      setPendingDelete(null);
      setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setDeleting(false);
    }
  };

  return (
    <section
      className="evaluation-directory"
      aria-labelledby={props.detail === undefined ? "evaluations-heading" : props.detailLabelledBy}
      style={{ "--sidebar-width": `${navigationWidth}px` } as CSSProperties}
    >
      <aside className="evaluation-target-directory" aria-label={t("evaluationTargets")}>
        <label className="evaluation-target-search">
          <MagnifyingGlass size={17} aria-hidden="true" />
          <span className="sr-only">{t("searchEvaluationTargets")}</span>
          <input
            type="search"
            value={search}
            placeholder={t("searchEvaluationTargets")}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>

        <div className="evaluation-target-groups">
          {groups.map((group) => {
            const GroupIcon = group.icon;
            const filtered = group.resources.filter((resource) => {
              if (normalizedSearch === "") return true;
              return `${resource.metadata.name} ${resource.metadata.description ?? ""} ${resource.metadata.id}`
                .toLocaleLowerCase(i18n.language)
                .includes(normalizedSearch);
            });
            const expanded = expandedKinds.has(group.kind) || normalizedSearch !== "";
            const visible = expanded ? filtered : filtered.slice(0, visibleTargetLimit);

            return (
              <section className="evaluation-target-group" key={group.kind}>
                <header>
                  <GroupIcon size={19} aria-hidden="true" />
                  <strong>{group.label}</strong>
                  <span>{group.resources.length}</span>
                </header>
                <div>
                  {visible.map((resource) => (
                    <button
                      className={
                        resource.metadata.id === selectedTarget?.metadata.id ? "is-active" : ""
                      }
                      type="button"
                      key={`${resource.kind}:${resource.metadata.id}`}
                      onClick={() => {
                        onSelectedTargetIdChange(resource.metadata.id);
                        props.onSelectTarget?.(resource);
                      }}
                    >
                      <GroupIcon size={17} aria-hidden="true" />
                      <span>{resource.metadata.name}</span>
                    </button>
                  ))}
                  {filtered.length === 0 && normalizedSearch !== "" ? (
                    <p>{t("noMatchingTargets")}</p>
                  ) : null}
                </div>
                {normalizedSearch === "" && filtered.length > visibleTargetLimit ? (
                  <button
                    className="evaluation-target-more"
                    type="button"
                    onClick={() =>
                      setExpandedKinds((current) => {
                        const next = new Set(current);
                        if (next.has(group.kind)) next.delete(group.kind);
                        else next.add(group.kind);
                        return next;
                      })
                    }
                  >
                    {expanded ? t("showLess") : t("showMore")}
                  </button>
                ) : null}
              </section>
            );
          })}
        </div>
      </aside>
      <SidebarResizeHandle
        label={t("navigation.resize", { ns: "common" })}
        width={navigationWidth}
        preference={SIDEBAR_WIDTH_PREFERENCES.evaluations}
        onResize={setNavigationWidth}
      />

      <div className="evaluation-directory-main">
        {props.detail ?? (
          <section className="evaluation-target-workspace" aria-live="polite">
            {selectedTarget === null ? (
              <div className="evaluation-target-empty">
                <h1 id="evaluations-heading">{t("noEvaluationTarget")}</h1>
                <p>{t("noEvaluationTargetDescription")}</p>
              </div>
            ) : (
              <>
                <header className="evaluation-target-heading">
                  <div>
                    <div className="evaluation-target-title">
                      {selectedTarget.kind === "Flow" ? (
                        <GitBranch size={24} aria-hidden="true" />
                      ) : selectedTarget.kind === "ExpertTeam" ? (
                        <UsersThree size={24} aria-hidden="true" />
                      ) : (
                        <User size={24} aria-hidden="true" />
                      )}
                      <h1 id="evaluations-heading">{selectedTarget.metadata.name}</h1>
                      <span>{targetKindLabel(selectedTarget.kind, t)}</span>
                    </div>
                    <p>
                      {selectedTarget.kind === "Flow"
                        ? t("flowRunDryDescription")
                        : t("llmJudgeDescription")}
                    </p>
                  </div>
                  <div className="evaluation-target-actions">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={allocating}
                      onClick={createEvaluation}
                    >
                      <Plus size={17} aria-hidden="true" />
                      {allocating
                        ? t("creatingEvaluation")
                        : selectedTarget.kind === "Flow"
                          ? t("newEvaluation")
                          : t("agentEvaluation.startNewRun")}
                    </button>
                    {selectedTarget.kind !== "Flow" && props.onOpenDatasets !== undefined ? (
                      <button
                        ref={datasetsButtonRef}
                        className="secondary-button"
                        type="button"
                        onClick={props.onOpenDatasets}
                      >
                        {t("agentEvaluation.tabs.datasets")}
                      </button>
                    ) : null}
                    {selectedTarget.kind !== "Flow" && props.onOpenQueue !== undefined ? (
                      <button
                        ref={queueButtonRef}
                        className="secondary-button"
                        type="button"
                        onClick={props.onOpenQueue}
                      >
                        {t("agentEvaluation.tabs.queue")}
                      </button>
                    ) : null}
                  </div>
                </header>

                {selectedTarget.kind === "Flow" ? (
                  <section className="evaluation-suite-list" aria-label={t("runDryEvaluations")}>
                    {targetEvaluations.length > 0 ? (
                      <div className="evaluation-suite-table">
                        <div className="evaluation-suite-table-heading" aria-hidden="true">
                          <span>{t("evaluationName")}</span>
                          <span>{t("caseCount")}</span>
                          <span />
                        </div>
                        {targetEvaluations.map((evaluation) => (
                          <div className="evaluation-suite-row" key={evaluation.metadata.id}>
                            <button
                              className="evaluation-suite-open"
                              type="button"
                              onClick={() => props.onOpen(evaluation)}
                            >
                              <span className="evaluation-suite-name">
                                <span className="evaluation-suite-file" aria-hidden="true">
                                  <GitBranch size={16} />
                                </span>
                                <strong>{evaluation.metadata.name}</strong>
                              </span>
                              <span>
                                {t("evaluationCaseCount", {
                                  count: evaluation.spec.method.cases.length,
                                })}
                              </span>
                            </button>
                            <span
                              className="evaluation-suite-actions"
                              onBlur={(event) => {
                                if (!event.currentTarget.contains(event.relatedTarget)) {
                                  setOpenMenuId(null);
                                }
                              }}
                            >
                              <button
                                type="button"
                                aria-label={t("moreActions", { name: evaluation.metadata.name })}
                                aria-haspopup="menu"
                                aria-expanded={openMenuId === evaluation.metadata.id}
                                onClick={() =>
                                  setOpenMenuId((current) =>
                                    current === evaluation.metadata.id
                                      ? null
                                      : evaluation.metadata.id,
                                  )
                                }
                              >
                                <DotsThree size={20} weight="bold" aria-hidden="true" />
                              </button>
                              {openMenuId === evaluation.metadata.id ? (
                                <div
                                  className="evaluation-suite-menu"
                                  role="menu"
                                  aria-label={t("moreActions", {
                                    name: evaluation.metadata.name,
                                  })}
                                >
                                  <button
                                    type="button"
                                    role="menuitem"
                                    onClick={() => {
                                      setOpenMenuId(null);
                                      setPendingDelete(evaluation);
                                      setError(null);
                                    }}
                                  >
                                    <Trash size={16} aria-hidden="true" />
                                    {t("deleteEvaluationAction")}
                                  </button>
                                </div>
                              ) : null}
                            </span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="evaluation-target-empty is-inline">
                        <span className="evaluation-target-empty-icon">
                          <Flask size={24} aria-hidden="true" />
                        </span>
                        <p>{t("noEvaluationsForFlow")}</p>
                        <button
                          className="secondary-button"
                          type="button"
                          onClick={createEvaluation}
                        >
                          <Plus size={17} aria-hidden="true" />
                          {t("newRunDryCase")}
                        </button>
                      </div>
                    )}
                  </section>
                ) : (
                  <div className="evaluation-target-empty is-inline">
                    <span className="evaluation-target-empty-icon">
                      <Flask size={24} aria-hidden="true" />
                    </span>
                    <p>{t("llmJudgeDescription")}</p>
                    {agentDatasetCount === 0 ? (
                      <small>{t("agentEvaluation.noDatasetsForRun")}</small>
                    ) : (
                      <button className="secondary-button" type="button" onClick={createEvaluation}>
                        <Plus size={17} aria-hidden="true" />
                        {t("agentEvaluation.startNewRun")}
                      </button>
                    )}
                  </div>
                )}
              </>
            )}
          </section>
        )}
      </div>
      {error ? (
        <p className="form-error evaluation-directory-error" role="alert">
          {error}
        </p>
      ) : null}
      {pendingDelete ? (
        <StudioConfirmationDialog
          title={t("deleteEvaluation")}
          description={t("deleteEvaluationDescription", {
            name: pendingDelete.metadata.name,
          })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteEvaluationAction")}
          busyLabel={t("deleting")}
          busy={deleting}
          onCancel={() => setPendingDelete(null)}
          onConfirm={() => void deleteEvaluation()}
        />
      ) : null}
    </section>
  );
}

function targetKindLabel(kind: EvaluationTargetKind, t: TFunction<"studio">): string {
  if (kind === "Flow") return t("flowSingular");
  if (kind === "ExpertTeam") return t("teamSingular");
  return t("expertSingular");
}
