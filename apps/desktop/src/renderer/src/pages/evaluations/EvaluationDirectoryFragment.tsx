import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import {
  CheckCircle,
  DotsThree,
  GitBranch,
  MagnifyingGlass,
  Play,
  Plus,
  User,
  UsersThree,
  WarningCircle,
} from "@phosphor-icons/react";
import type { PragmaEvaluationResource, PragmaFlowRunDrySuiteResult } from "@pragma/evaluation/ast";
import {
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
  type PragmaFlowResource,
} from "@pragma/interpreter/ast";

import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "../studio/StudioScreenFrame.tsx";
import { desktopApi } from "../studio/studio-model.ts";

type EvaluationTarget = PragmaExpertResource | PragmaExpertTeamResource | PragmaFlowResource;
type EvaluationTargetKind = EvaluationTarget["kind"];
type EvaluationRunState = {
  readonly result: PragmaFlowRunDrySuiteResult;
  readonly finishedAt: Date;
};

const visibleTargetLimit = 4;

export function activateEvaluationDirectory(mounted: { current: boolean }): () => void {
  mounted.current = true;

  return () => {
    mounted.current = false;
  };
}

export function evaluationsForTarget(
  evaluations: readonly PragmaEvaluationResource[],
  target: EvaluationTarget | null,
): readonly PragmaEvaluationResource[] {
  if (target?.kind !== "Flow") return [];
  const targetRef = `flow:${target.metadata.id}`;
  return evaluations.filter((evaluation) => evaluation.spec.target.ref === targetRef);
}

export function EvaluationDirectoryFragment(props: {
  readonly project: PragmaProjectSnapshot;
  readonly onOpen: (evaluation: PragmaEvaluationResource) => void;
  readonly onCreate: (resourceId: string, flow: PragmaFlowResource) => void;
  readonly onRun: (evaluation: PragmaEvaluationResource) => Promise<PragmaFlowRunDrySuiteResult>;
}) {
  const { t, i18n } = useTranslation("studio");
  const [error, setError] = useState<string | null>(null);
  const [allocating, setAllocating] = useState(false);
  const [running, setRunning] = useState(false);
  const [search, setSearch] = useState("");
  const [expandedKinds, setExpandedKinds] = useState<ReadonlySet<EvaluationTargetKind>>(new Set());
  const [runStates, setRunStates] = useState<
    Readonly<Record<string, EvaluationRunState | undefined>>
  >({});
  const mountedRef = useRef(false);
  useEffect(() => activateEvaluationDirectory(mountedRef), []);

  const { evaluations, experts, teams, flows, targets, defaultTargetId } = useMemo(() => {
    const evaluations: PragmaEvaluationResource[] = [];
    const experts: PragmaExpertResource[] = [];
    const teams: PragmaExpertTeamResource[] = [];
    const flows: PragmaFlowResource[] = [];
    const targets: EvaluationTarget[] = [];
    for (const resource of props.project.resources) {
      if (resource.kind === "Evaluation") {
        evaluations.push(resource);
        continue;
      }
      if (resource.kind === "Expert") experts.push(resource);
      else if (resource.kind === "ExpertTeam") teams.push(resource);
      else if (resource.kind === "Flow") flows.push(resource);
      else continue;
      targets.push(resource);
    }
    const evaluatedFlowId = evaluations[0]?.spec.target.ref.replace(/^flow:/, "");
    const defaultTargetId =
      flows.find((flow) => flow.metadata.id === evaluatedFlowId)?.metadata.id ??
      flows[0]?.metadata.id ??
      targets[0]?.metadata.id ??
      "";
    return { evaluations, experts, teams, flows, targets, defaultTargetId };
  }, [props.project.resources]);
  const [selectedTargetId, setSelectedTargetId] = useState(defaultTargetId);
  const selectedTarget = targets.find((target) => target.metadata.id === selectedTargetId) ?? null;

  useEffect(() => {
    if (selectedTarget === null && defaultTargetId !== "") setSelectedTargetId(defaultTargetId);
  }, [defaultTargetId, selectedTarget]);

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

  const runAll = async () => {
    if (running || targetEvaluations.length === 0) return;
    setRunning(true);
    setError(null);
    try {
      for (const evaluation of targetEvaluations) {
        const result = await props.onRun(evaluation);
        if (!mountedRef.current) return;
        setRunStates((current) => ({
          ...current,
          [evaluation.metadata.id]: { result, finishedAt: new Date() },
        }));
      }
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setRunning(false);
    }
  };

  return (
    <StudioScreenFrame
      className="evaluation-directory"
      labelledBy="evaluations-heading"
      header={
        <header className="studio-heading evaluation-directory-heading">
          <div>
            <h1 id="evaluations-heading">{t("evaluations")}</h1>
            <p>{t("evaluationsDescription")}</p>
          </div>
          <button
            className="primary-button"
            type="button"
            disabled={selectedTarget?.kind !== "Flow" || allocating}
            title={selectedTarget?.kind === "Flow" ? undefined : t("flowRunDryOnly")}
            onClick={createEvaluation}
          >
            <Plus size={17} aria-hidden="true" />
            {allocating ? t("creatingEvaluation") : t("newEvaluation")}
          </button>
        </header>
      }
    >
      <div className="evaluation-directory-shell">
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
                        onClick={() => setSelectedTargetId(resource.metadata.id)}
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

        <section className="evaluation-target-workspace" aria-live="polite">
          {selectedTarget === null ? (
            <div className="evaluation-target-empty">
              <h2>{t("noEvaluationTarget")}</h2>
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
                    <h2>{selectedTarget.metadata.name}</h2>
                    <span>{targetKindLabel(selectedTarget.kind, t)}</span>
                  </div>
                  <p>
                    {selectedTarget.kind === "Flow"
                      ? t("flowRunDryDescription")
                      : t("unsupportedEvaluationTargetDescription")}
                  </p>
                </div>
                {selectedTarget.kind === "Flow" ? (
                  <div className="evaluation-target-actions">
                    <button
                      className="primary-button"
                      type="button"
                      disabled={allocating}
                      onClick={createEvaluation}
                    >
                      <Plus size={17} aria-hidden="true" />
                      {allocating ? t("creatingEvaluation") : t("newRunDryCase")}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={running || targetEvaluations.length === 0}
                      onClick={() => void runAll()}
                    >
                      <Play size={17} aria-hidden="true" />
                      {running ? t("runningRunDry") : t("runAllCases")}
                    </button>
                  </div>
                ) : null}
              </header>

              {selectedTarget.kind === "Flow" ? (
                <section className="evaluation-suite-list" aria-label={t("runDryEvaluations")}>
                  <h3>{t("runDryEvaluations")}</h3>
                  {targetEvaluations.length > 0 ? (
                    <div className="evaluation-suite-table">
                      <div className="evaluation-suite-table-heading" aria-hidden="true">
                        <span>{t("evaluationName")}</span>
                        <span>{t("caseCount")}</span>
                        <span>{t("coverageStatus")}</span>
                        <span>{t("lastResult")}</span>
                        <span>{t("lastRun")}</span>
                        <span />
                      </div>
                      {targetEvaluations.map((evaluation) => {
                        const runState = runStates[evaluation.metadata.id];
                        const failedCases = runState?.result.summary.failed ?? 0;
                        return (
                          <button
                            className="evaluation-suite-row"
                            type="button"
                            key={evaluation.metadata.id}
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
                            <span>{coverageLabel(runState?.result, t)}</span>
                            <span
                              className={
                                runState === undefined
                                  ? "evaluation-run-status"
                                  : runState.result.passed
                                    ? "evaluation-run-status is-success"
                                    : "evaluation-run-status is-error"
                              }
                            >
                              {runState === undefined ? null : runState.result.passed ? (
                                <CheckCircle size={17} weight="fill" aria-hidden="true" />
                              ) : (
                                <WarningCircle size={17} weight="fill" aria-hidden="true" />
                              )}
                              {runState === undefined
                                ? t("notRun")
                                : runState.result.passed
                                  ? t("passed")
                                  : t("failedCases", { count: failedCases })}
                            </span>
                            <span>
                              {runState === undefined
                                ? "—"
                                : new Intl.DateTimeFormat(i18n.language, {
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  }).format(runState.finishedAt)}
                            </span>
                            <DotsThree size={20} weight="bold" aria-hidden="true" />
                          </button>
                        );
                      })}
                    </div>
                  ) : (
                    <div className="evaluation-target-empty is-inline">
                      <h2>{t("noEvaluationsYet")}</h2>
                      <p>{t("noEvaluationsForFlow")}</p>
                      <button className="secondary-button" type="button" onClick={createEvaluation}>
                        <Plus size={17} aria-hidden="true" />
                        {t("newRunDryCase")}
                      </button>
                    </div>
                  )}
                </section>
              ) : (
                <div className="evaluation-target-empty is-inline">
                  <h2>{t("evaluationMethodUnavailable")}</h2>
                  <p>{t("flowRunDryOnly")}</p>
                </div>
              )}
            </>
          )}
        </section>
      </div>
      {error ? (
        <p className="form-error evaluation-directory-error" role="alert">
          {error}
        </p>
      ) : null}
    </StudioScreenFrame>
  );
}

function targetKindLabel(kind: EvaluationTargetKind, t: TFunction<"studio">): string {
  if (kind === "Flow") return t("flowSingular");
  if (kind === "ExpertTeam") return t("teamSingular");
  return t("expertSingular");
}

function coverageLabel(
  result: PragmaFlowRunDrySuiteResult | undefined,
  t: TFunction<"studio">,
): string {
  if (result === undefined) return "—";
  return t("coverageRatio", {
    covered: result.coverage.covered.length,
    required: result.coverage.required.length,
  });
}
