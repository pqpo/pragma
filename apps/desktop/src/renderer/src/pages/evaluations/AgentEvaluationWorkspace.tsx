import { ArrowLeft, FileArrowUp, Flask, Plus, Trash, X } from "@phosphor-icons/react";
import { type KeyboardEvent, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  PRAGMA_DSL_WRITE_API_VERSION,
  type PragmaAgentJudgeEvaluationResource,
  type PragmaExpertResource,
  type PragmaExpertTeamResource,
} from "@pragma/interpreter/ast";
import { stringify as stringifyYaml } from "yaml";

import type {
  AgentEvaluationRun,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";
import { Dialog } from "../../components/Dialog.tsx";

type AgentTarget = PragmaExpertResource | PragmaExpertTeamResource;

export function AgentEvaluationRunSetup(props: {
  readonly project: PragmaProjectSnapshot;
  readonly target: AgentTarget;
  readonly onBack: () => void;
  readonly onCreated: () => void;
}) {
  const { t } = useTranslation("studio");
  const datasets = agentDatasets(props.project);
  const [datasetId, setDatasetId] = useState(datasets[0]?.metadata.id ?? "");
  const selected = datasets.find((dataset) => dataset.metadata.id === datasetId);
  const [sampleSize, setSampleSize] = useState(1);
  const [liveConfirmed, setLiveConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (selected !== undefined) {
      setSampleSize((current) => Math.min(Math.max(current, 1), selected.spec.method.cases.length));
      setLiveConfirmed(false);
    }
  }, [selected]);

  const create = async () => {
    if (selected === undefined) return;
    const api = window.pragmaDesktop;
    setBusy(true);
    setError(null);
    try {
      await api.createAgentEvaluationRun({
        projectRevision: props.project.revision,
        evaluationRef: `evaluation:${selected.metadata.id}`,
        targetRef: `${props.target.kind === "Expert" ? "expert" : "team"}:${props.target.metadata.id}`,
        sampleSize,
        liveConfirmed,
      });
      props.onCreated();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-evaluation-card" aria-labelledby="agent-evaluation-run-heading">
      <button className="secondary-button" type="button" onClick={props.onBack}>
        {t("agentEvaluation.back")}
      </button>
      <header>
        <p className="studio-eyebrow">{t("agentEvaluation.newRun")}</p>
        <h1 id="agent-evaluation-run-heading">{props.target.metadata.name}</h1>
        <p>{t("agentEvaluation.runDescription")}</p>
      </header>
      {datasets.length === 0 ? (
        <p className="studio-empty-copy">{t("agentEvaluation.noDatasetsForRun")}</p>
      ) : (
        <div className="agent-evaluation-form">
          <div className="agent-evaluation-field">
            <span>{t("agentEvaluation.dataset")}</span>
            <SelectMenu
              ariaLabel={t("agentEvaluation.dataset")}
              value={datasetId}
              options={datasets.map((dataset) => ({
                value: dataset.metadata.id,
                label: `${dataset.spec.method.group} · ${dataset.metadata.name}`,
              }))}
              onChange={setDatasetId}
            />
          </div>
          <label>
            <span>{t("agentEvaluation.sampleSize")}</span>
            <input
              type="number"
              min={1}
              max={selected?.spec.method.cases.length ?? 1}
              value={sampleSize}
              onChange={(event) => setSampleSize(Number(event.target.value))}
            />
            <small>
              {t("agentEvaluation.randomSampleHint", {
                count: selected?.spec.method.cases.length ?? 0,
              })}
            </small>
          </label>
          {selected?.spec.method.execution.mode === "live" ? (
            <label className="agent-evaluation-confirmation">
              <input
                type="checkbox"
                checked={liveConfirmed}
                onChange={(event) => setLiveConfirmed(event.target.checked)}
              />
              <span>{t("agentEvaluation.liveConfirmation")}</span>
            </label>
          ) : null}
          <button
            className="primary-button"
            type="button"
            disabled={busy || (selected?.spec.method.execution.mode === "live" && !liveConfirmed)}
            onClick={() => void create()}
          >
            {busy ? t("agentEvaluation.creating") : t("agentEvaluation.start")}
          </button>
        </div>
      )}
      {error !== null ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

export function AgentEvaluationDatasets(props: {
  readonly project: PragmaProjectSnapshot;
  readonly onBack: () => void;
  readonly onProjectChange: (project: PragmaProjectSnapshot) => void;
}) {
  const { t } = useTranslation("studio");
  const datasets = agentDatasets(props.project);
  const [resourceId, setResourceId] = useState("");
  const [source, setSource] = useState("");
  const [editing, setEditing] = useState(false);
  const [editorMode, setEditorMode] = useState<"form" | "yaml">("form");
  const [form, setForm] = useState<DatasetFormState>(() => createDatasetForm());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const formTabRef = useRef<HTMLButtonElement>(null);
  const yamlTabRef = useRef<HTMLButtonElement>(null);

  const begin = async () => {
    setBusy(true);
    try {
      const { id } = await window.pragmaDesktop.allocatePragmaResourceId();
      setResourceId(id);
      setSource(datasetTemplate(id));
      setForm(createDatasetForm());
      setEditorMode("form");
      setEditing(true);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async (yamlSource: string) => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.pragmaDesktop.importAgentEvaluationDatasetYaml({
        baseRevision: props.project.revision,
        source: yamlSource,
      });
      props.onProjectChange(next);
      setEditing(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const submit = () => {
    if (editorMode === "form" && !datasetFormIsValid(form)) {
      setError(t("agentEvaluation.formValidationError"));
      return;
    }
    void save(
      editorMode === "form"
        ? stringifyYaml(datasetFromForm(resourceId, form), { lineWidth: 0 })
        : source,
    );
  };
  const moveEditorTab = (event: KeyboardEvent<HTMLButtonElement>) => {
    let nextMode: "form" | "yaml" | undefined;
    if (event.key === "ArrowLeft" || event.key === "Home") nextMode = "form";
    if (event.key === "ArrowRight" || event.key === "End") nextMode = "yaml";
    if (nextMode === undefined) return;
    event.preventDefault();
    setEditorMode(nextMode);
    (nextMode === "form" ? formTabRef : yamlTabRef).current?.focus();
  };

  return (
    <section
      className="agent-evaluation-page-section"
      aria-labelledby="agent-evaluation-datasets-heading"
    >
      <button
        className="agent-evaluation-secondary-back"
        type="button"
        autoFocus
        onClick={props.onBack}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        {t("agentEvaluation.backToTarget")}
      </button>
      <header className="agent-evaluation-section-heading">
        <div>
          <h1 id="agent-evaluation-datasets-heading">{t("agentEvaluation.datasets")}</h1>
          <p>{t("agentEvaluation.datasetsDescription")}</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void begin()}
        >
          <Plus size={17} aria-hidden="true" />
          {t("agentEvaluation.newDataset")}
        </button>
      </header>
      {editing ? (
        <Dialog
          title={t("agentEvaluation.createDataset")}
          description={t("agentEvaluation.createDatasetDescription")}
          className="agent-evaluation-dataset-dialog"
          busy={busy}
          onCancel={() => setEditing(false)}
          footer={
            <>
              <button
                className="secondary-button"
                type="button"
                disabled={busy}
                onClick={() => setEditing(false)}
              >
                {t("agentEvaluation.cancel")}
              </button>
              <button className="primary-button" type="button" disabled={busy} onClick={submit}>
                {busy ? t("agentEvaluation.savingDataset") : t("agentEvaluation.saveDataset")}
              </button>
            </>
          }
        >
          <div
            className="agent-evaluation-editor-tabs"
            role="tablist"
            aria-label={t("agentEvaluation.createDataset")}
          >
            <button
              ref={formTabRef}
              id="agent-evaluation-form-tab"
              className={editorMode === "form" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={editorMode === "form"}
              aria-controls="agent-evaluation-form-panel"
              tabIndex={editorMode === "form" ? 0 : -1}
              onClick={() => setEditorMode("form")}
              onKeyDown={moveEditorTab}
            >
              <Flask size={17} aria-hidden="true" />
              {t("agentEvaluation.formCreate")}
            </button>
            <button
              ref={yamlTabRef}
              id="agent-evaluation-yaml-tab"
              className={editorMode === "yaml" ? "is-active" : ""}
              type="button"
              role="tab"
              aria-selected={editorMode === "yaml"}
              aria-controls="agent-evaluation-yaml-panel"
              tabIndex={editorMode === "yaml" ? 0 : -1}
              onClick={() => setEditorMode("yaml")}
              onKeyDown={moveEditorTab}
            >
              <FileArrowUp size={17} aria-hidden="true" />
              {t("agentEvaluation.importYaml")}
            </button>
          </div>
          {editorMode === "form" ? (
            <div
              id="agent-evaluation-form-panel"
              role="tabpanel"
              aria-labelledby="agent-evaluation-form-tab"
            >
              <DatasetForm value={form} onChange={setForm} />
            </div>
          ) : (
            <div
              id="agent-evaluation-yaml-panel"
              role="tabpanel"
              aria-labelledby="agent-evaluation-yaml-tab"
            >
              <DatasetYamlEditor
                source={source}
                onChange={(nextSource) => {
                  setSource(nextSource);
                  setError(null);
                }}
                onReadError={() => setError(t("agentEvaluation.yamlReadError"))}
              />
            </div>
          )}
          {error !== null ? (
            <p className="form-error" role="alert">
              {error}
            </p>
          ) : null}
        </Dialog>
      ) : null}
      <div className="agent-evaluation-dataset-grid">
        {datasets.map((dataset) => (
          <article key={dataset.metadata.id}>
            <span>{dataset.spec.method.group}</span>
            <h2>{dataset.metadata.name}</h2>
            <p>{dataset.metadata.description}</p>
            <footer>
              <span>{dataset.spec.method.execution.mode.toUpperCase()}</span>
              <span>
                {t("agentEvaluation.caseTotal", { count: dataset.spec.method.cases.length })}
              </span>
            </footer>
          </article>
        ))}
      </div>
      {datasets.length === 0 && !editing ? (
        <div className="agent-evaluation-empty-state">
          <span className="agent-evaluation-empty-icon">
            <Flask size={24} aria-hidden="true" />
          </span>
          <h2>{t("agentEvaluation.noDatasets")}</h2>
          <p>{t("agentEvaluation.noDatasetsDescription")}</p>
          <button className="secondary-button" type="button" onClick={() => void begin()}>
            <Plus size={17} aria-hidden="true" />
            {t("agentEvaluation.createFirstDataset")}
          </button>
        </div>
      ) : null}
      {error !== null && !editing ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

export function AgentEvaluationQueue(props: { readonly onBack: () => void }) {
  const { t } = useTranslation("studio");
  const [runs, setRuns] = useState<AgentEvaluationRun[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const nextRuns = await window.pragmaDesktop.listAgentEvaluationRuns();
        if (!active) return;
        setRuns(nextRuns);
        setError(null);
      } catch (cause) {
        if (active) setError(errorMessage(cause));
      }
    };
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1_000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const retryTask = async (runId: string, caseId: string) => {
    const action = `retry:${runId}:${caseId}`;
    setPendingAction(action);
    setError(null);
    try {
      await window.pragmaDesktop.retryAgentEvaluationTask({ id: runId, caseId });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  };
  const cancelRun = async (runId: string) => {
    const action = `cancel:${runId}`;
    setPendingAction(action);
    setError(null);
    try {
      await window.pragmaDesktop.cancelAgentEvaluationRun({ id: runId });
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPendingAction(null);
    }
  };

  return (
    <section
      className="agent-evaluation-page-section"
      aria-labelledby="agent-evaluation-queue-heading"
    >
      <button
        className="agent-evaluation-secondary-back"
        type="button"
        autoFocus
        onClick={props.onBack}
      >
        <ArrowLeft size={16} aria-hidden="true" />
        {t("agentEvaluation.backToTarget")}
      </button>
      <header className="agent-evaluation-section-heading">
        <div>
          <h1 id="agent-evaluation-queue-heading">{t("agentEvaluation.queue")}</h1>
          <p>{t("agentEvaluation.queueDescription")}</p>
        </div>
      </header>
      <div className="agent-evaluation-queue-layout">
        <div className="agent-evaluation-run-list">
          {runs.map((run) => (
            <button
              type="button"
              className={run.id === selected?.id ? "is-active" : ""}
              key={run.id}
              onClick={() => setSelectedId(run.id)}
            >
              <strong>{run.targetName}</strong>
              <span>{run.evaluationName}</span>
              <small>
                {run.status} · {Math.round(run.summary.resolvedRate * 100)}%
              </small>
            </button>
          ))}
        </div>
        {selected === undefined ? (
          <div className="agent-evaluation-empty-state is-queue">
            <span className="agent-evaluation-empty-icon">
              <Flask size={24} aria-hidden="true" />
            </span>
            <h2>{t("agentEvaluation.noRuns")}</h2>
            <p>{t("agentEvaluation.noRunsDescription")}</p>
          </div>
        ) : (
          <article className="agent-evaluation-run-detail">
            <header>
              <div>
                <span>{selected.group}</span>
                <h2>{selected.targetName}</h2>
                <p>
                  {selected.evaluationName} · {selected.executionMode.toUpperCase()}
                </p>
              </div>
              <strong>{Math.round(selected.summary.resolvedRate * 100)}%</strong>
            </header>
            <div className="agent-evaluation-task-list">
              {selected.tasks.map((task) => (
                <div key={task.caseId}>
                  <span className={`agent-evaluation-status is-${task.status}`} />
                  <div>
                    <strong>{task.caseName}</strong>
                    <small>
                      {task.status}
                      {task.error === undefined ? "" : ` · ${task.error}`}
                    </small>
                  </div>
                  {task.status === "needs_attention" || task.status === "unresolved" ? (
                    <button
                      type="button"
                      disabled={pendingAction !== null}
                      onClick={() => void retryTask(selected.id, task.caseId)}
                    >
                      {t("agentEvaluation.retry")}
                    </button>
                  ) : null}
                </div>
              ))}
            </div>
            {selected.status === "queued" || selected.status === "running" ? (
              <button
                className="secondary-button"
                type="button"
                disabled={pendingAction !== null}
                onClick={() => void cancelRun(selected.id)}
              >
                {t("agentEvaluation.cancelRun")}
              </button>
            ) : null}
          </article>
        )}
      </div>
      {error !== null ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

interface DatasetCriterionDraft {
  readonly key: string;
  readonly id: string;
  readonly description: string;
}

interface DatasetCaseDraft {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly prompt: string;
  readonly referenceAnswer: string;
  readonly outputContains: string;
  readonly outputNotContains: string;
  readonly criteria: readonly DatasetCriterionDraft[];
}

interface DatasetFormState {
  readonly name: string;
  readonly description: string;
  readonly group: string;
  readonly tags: string;
  readonly executionMode: "mock" | "live";
  readonly cases: readonly DatasetCaseDraft[];
}

let datasetDraftSequence = 0;
function nextDatasetDraftKey(): string {
  datasetDraftSequence += 1;
  return `dataset-draft-${datasetDraftSequence}`;
}

export function createDatasetCriterionDraft(
  existing: readonly DatasetCriterionDraft[] = [],
): DatasetCriterionDraft {
  return {
    key: nextDatasetDraftKey(),
    id:
      existing.length === 0
        ? "correct_answer"
        : nextAvailableDraftId(
            "criterion",
            existing.map((criterion) => criterion.id),
          ),
    description: "",
  };
}

export function createDatasetCaseDraft(
  existing: readonly DatasetCaseDraft[] = [],
): DatasetCaseDraft {
  return {
    key: nextDatasetDraftKey(),
    id: nextAvailableDraftId(
      "case",
      existing.map((testCase) => testCase.id),
    ),
    name: "",
    prompt: "",
    referenceAnswer: "",
    outputContains: "",
    outputNotContains: "",
    criteria: [createDatasetCriterionDraft()],
  };
}

export function createDatasetForm(): DatasetFormState {
  return {
    name: "",
    description: "",
    group: "",
    tags: "agent-judge",
    executionMode: "mock",
    cases: [createDatasetCaseDraft()],
  };
}

function DatasetForm(props: {
  readonly value: DatasetFormState;
  readonly onChange: (value: DatasetFormState) => void;
}) {
  const { t } = useTranslation("studio");
  const updateCase = (key: string, update: (value: DatasetCaseDraft) => DatasetCaseDraft) => {
    props.onChange({
      ...props.value,
      cases: props.value.cases.map((item) => (item.key === key ? update(item) : item)),
    });
  };

  return (
    <form className="agent-evaluation-dataset-form" onSubmit={(event) => event.preventDefault()}>
      <section className="agent-evaluation-form-section">
        <header>
          <strong>{t("agentEvaluation.basicInformation")}</strong>
          <span>{t("agentEvaluation.basicInformationDescription")}</span>
        </header>
        <div className="agent-evaluation-form-grid">
          <label>
            <span>{t("agentEvaluation.datasetName")}</span>
            <input
              data-dialog-initial-focus
              required
              value={props.value.name}
              maxLength={200}
              placeholder={t("agentEvaluation.datasetNamePlaceholder")}
              onChange={(event) => props.onChange({ ...props.value, name: event.target.value })}
            />
          </label>
          <label>
            <span>{t("agentEvaluation.capabilityGroup")}</span>
            <input
              required
              value={props.value.group}
              maxLength={100}
              placeholder={t("agentEvaluation.capabilityGroupPlaceholder")}
              onChange={(event) => props.onChange({ ...props.value, group: event.target.value })}
            />
          </label>
          <label className="is-wide">
            <span>{t("agentEvaluation.datasetDescription")}</span>
            <textarea
              required
              value={props.value.description}
              maxLength={4000}
              rows={3}
              placeholder={t("agentEvaluation.datasetDescriptionPlaceholder")}
              onChange={(event) =>
                props.onChange({ ...props.value, description: event.target.value })
              }
            />
          </label>
          <label>
            <span>{t("agentEvaluation.executionMode")}</span>
            <SelectMenu
              ariaLabel={t("agentEvaluation.executionMode")}
              value={props.value.executionMode}
              options={[
                { value: "mock", label: t("agentEvaluation.mockMode") },
                { value: "live", label: t("agentEvaluation.liveMode") },
              ]}
              onChange={(executionMode) => props.onChange({ ...props.value, executionMode })}
            />
          </label>
          <label>
            <span>{t("agentEvaluation.tags")}</span>
            <input
              value={props.value.tags}
              placeholder={t("agentEvaluation.tagsPlaceholder")}
              onChange={(event) => props.onChange({ ...props.value, tags: event.target.value })}
            />
          </label>
        </div>
      </section>

      <section className="agent-evaluation-form-section agent-evaluation-cases-section">
        <header>
          <strong>{t("agentEvaluation.testCases")}</strong>
          <span>{t("agentEvaluation.testCasesDescription")}</span>
        </header>
        <div className="agent-evaluation-case-stack">
          {props.value.cases.map((testCase, caseIndex) => (
            <article className="agent-evaluation-case-card" key={testCase.key}>
              <header>
                <span>{t("agentEvaluation.caseNumber", { count: caseIndex + 1 })}</span>
                {props.value.cases.length > 1 ? (
                  <button
                    type="button"
                    title={t("agentEvaluation.removeCase")}
                    aria-label={t("agentEvaluation.removeCase")}
                    onClick={() =>
                      props.onChange({
                        ...props.value,
                        cases: props.value.cases.filter((item) => item.key !== testCase.key),
                      })
                    }
                  >
                    <Trash size={16} aria-hidden="true" />
                  </button>
                ) : null}
              </header>
              <div className="agent-evaluation-form-grid">
                <label>
                  <span>{t("agentEvaluation.caseId")}</span>
                  <input
                    required
                    value={testCase.id}
                    maxLength={100}
                    aria-invalid={
                      !validDatasetId(testCase.id) ||
                      !draftIdsAreUnique(props.value.cases.map((item) => item.id)) ||
                      undefined
                    }
                    onChange={(event) =>
                      updateCase(testCase.key, (current) => ({
                        ...current,
                        id: event.target.value,
                      }))
                    }
                  />
                </label>
                <label>
                  <span>{t("agentEvaluation.caseName")}</span>
                  <input
                    required
                    value={testCase.name}
                    maxLength={200}
                    placeholder={t("agentEvaluation.caseNamePlaceholder")}
                    onChange={(event) =>
                      updateCase(testCase.key, (current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="is-wide">
                  <span>{t("agentEvaluation.casePrompt")}</span>
                  <textarea
                    required
                    value={testCase.prompt}
                    rows={4}
                    placeholder={t("agentEvaluation.casePromptPlaceholder")}
                    onChange={(event) =>
                      updateCase(testCase.key, (current) => ({
                        ...current,
                        prompt: event.target.value,
                      }))
                    }
                  />
                </label>
                <label className="is-wide">
                  <span>{t("agentEvaluation.referenceAnswer")}</span>
                  <textarea
                    value={testCase.referenceAnswer}
                    rows={2}
                    placeholder={t("agentEvaluation.referenceAnswerPlaceholder")}
                    onChange={(event) =>
                      updateCase(testCase.key, (current) => ({
                        ...current,
                        referenceAnswer: event.target.value,
                      }))
                    }
                  />
                </label>
              </div>
              <div className="agent-evaluation-criteria-list">
                <strong>{t("agentEvaluation.judgeCriteria")}</strong>
                {testCase.criteria.map((criterion) => (
                  <div key={criterion.key}>
                    <input
                      required
                      aria-label={t("agentEvaluation.criterionId")}
                      value={criterion.id}
                      maxLength={100}
                      aria-invalid={
                        !validDatasetId(criterion.id) ||
                        !draftIdsAreUnique(testCase.criteria.map((item) => item.id)) ||
                        undefined
                      }
                      onChange={(event) =>
                        updateCase(testCase.key, (current) => ({
                          ...current,
                          criteria: current.criteria.map((item) =>
                            item.key === criterion.key ? { ...item, id: event.target.value } : item,
                          ),
                        }))
                      }
                    />
                    <input
                      required
                      aria-label={t("agentEvaluation.criterionDescription")}
                      value={criterion.description}
                      maxLength={2000}
                      placeholder={t("agentEvaluation.criterionDescriptionPlaceholder")}
                      onChange={(event) =>
                        updateCase(testCase.key, (current) => ({
                          ...current,
                          criteria: current.criteria.map((item) =>
                            item.key === criterion.key
                              ? { ...item, description: event.target.value }
                              : item,
                          ),
                        }))
                      }
                    />
                    {testCase.criteria.length > 1 ? (
                      <button
                        type="button"
                        aria-label={t("agentEvaluation.removeCriterion")}
                        title={t("agentEvaluation.removeCriterion")}
                        onClick={() =>
                          updateCase(testCase.key, (current) => ({
                            ...current,
                            criteria: current.criteria.filter((item) => item.key !== criterion.key),
                          }))
                        }
                      >
                        <X size={15} aria-hidden="true" />
                      </button>
                    ) : null}
                  </div>
                ))}
                <button
                  className="text-button"
                  type="button"
                  onClick={() =>
                    updateCase(testCase.key, (current) => ({
                      ...current,
                      criteria: [
                        ...current.criteria,
                        createDatasetCriterionDraft(current.criteria),
                      ],
                    }))
                  }
                >
                  <Plus size={15} aria-hidden="true" />
                  {t("agentEvaluation.addCriterion")}
                </button>
              </div>
              <details className="agent-evaluation-assertions">
                <summary>{t("agentEvaluation.hardAssertions")}</summary>
                <div className="agent-evaluation-form-grid">
                  <label>
                    <span>{t("agentEvaluation.outputContains")}</span>
                    <textarea
                      value={testCase.outputContains}
                      rows={3}
                      placeholder={t("agentEvaluation.onePerLine")}
                      onChange={(event) =>
                        updateCase(testCase.key, (current) => ({
                          ...current,
                          outputContains: event.target.value,
                        }))
                      }
                    />
                  </label>
                  <label>
                    <span>{t("agentEvaluation.outputNotContains")}</span>
                    <textarea
                      value={testCase.outputNotContains}
                      rows={3}
                      placeholder={t("agentEvaluation.onePerLine")}
                      onChange={(event) =>
                        updateCase(testCase.key, (current) => ({
                          ...current,
                          outputNotContains: event.target.value,
                        }))
                      }
                    />
                  </label>
                </div>
                <small>{t("agentEvaluation.advancedYamlHint")}</small>
              </details>
            </article>
          ))}
        </div>
        <button
          className="secondary-button agent-evaluation-add-case"
          type="button"
          onClick={() =>
            props.onChange({
              ...props.value,
              cases: [...props.value.cases, createDatasetCaseDraft(props.value.cases)],
            })
          }
        >
          <Plus size={17} aria-hidden="true" />
          {t("agentEvaluation.addCase")}
        </button>
      </section>
    </form>
  );
}

function DatasetYamlEditor(props: {
  readonly source: string;
  readonly onChange: (source: string) => void;
  readonly onReadError: () => void;
}) {
  const { t } = useTranslation("studio");
  return (
    <div className="agent-evaluation-yaml-import">
      <section className="agent-evaluation-yaml-guide">
        <h3>{t("agentEvaluation.yamlFormat")}</h3>
        <p>{t("agentEvaluation.yamlFormatDescription")}</p>
        <ul>
          <li>{t("agentEvaluation.yamlRuleMetadata")}</li>
          <li>{t("agentEvaluation.yamlRuleCases")}</li>
          <li>{t("agentEvaluation.yamlRuleLive")}</li>
        </ul>
        <details>
          <summary>{t("agentEvaluation.viewYamlExample")}</summary>
          <pre>{datasetTemplate("7h8j9k0m1n2p3q4r")}</pre>
        </details>
      </section>
      <section className="agent-evaluation-yaml-editor">
        <label className="agent-evaluation-file-picker">
          <FileArrowUp size={17} aria-hidden="true" />
          <span>{t("agentEvaluation.chooseYamlFile")}</span>
          <input
            type="file"
            accept=".yaml,.yml,application/yaml,text/yaml,text/x-yaml"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) {
                void file.text().then(props.onChange).catch(props.onReadError);
              }
              event.target.value = "";
            }}
          />
        </label>
        <label>
          <span>{t("agentEvaluation.yamlSource")}</span>
          <textarea
            value={props.source}
            spellCheck={false}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </label>
      </section>
    </div>
  );
}

export function datasetFormIsValid(value: DatasetFormState): boolean {
  return (
    value.name.trim() !== "" &&
    value.description.trim() !== "" &&
    value.group.trim() !== "" &&
    value.cases.length > 0 &&
    draftIdsAreUnique(value.cases.map((testCase) => testCase.id)) &&
    value.cases.every(
      (testCase) =>
        validDatasetId(testCase.id) &&
        testCase.name.trim() !== "" &&
        testCase.prompt.trim() !== "" &&
        testCase.criteria.length > 0 &&
        draftIdsAreUnique(testCase.criteria.map((criterion) => criterion.id)) &&
        testCase.criteria.every(
          (criterion) => validDatasetId(criterion.id) && criterion.description.trim() !== "",
        ),
    )
  );
}

function nextAvailableDraftId(prefix: string, ids: readonly string[]): string {
  const existing = new Set(ids.map((id) => id.trim()));
  let index = 1;
  while (existing.has(`${prefix}_${index}`)) index += 1;
  return `${prefix}_${index}`;
}

function draftIdsAreUnique(ids: readonly string[]): boolean {
  const normalized = ids.map((id) => id.trim());
  return new Set(normalized).size === normalized.length;
}

function validDatasetId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value.trim());
}

function nonEmptyLines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

export function datasetFromForm(
  resourceId: string,
  value: DatasetFormState,
): PragmaAgentJudgeEvaluationResource {
  return {
    apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
    kind: "Evaluation",
    metadata: {
      id: resourceId,
      name: value.name.trim(),
      description: value.description.trim(),
      tags: value.tags
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    },
    spec: {
      method: {
        type: "agent-judge",
        group: value.group.trim(),
        execution: { mode: value.executionMode },
        cases: value.cases.map((testCase) => ({
          id: testCase.id.trim(),
          name: testCase.name.trim(),
          prompt: testCase.prompt.trim(),
          ...(testCase.referenceAnswer.trim() === ""
            ? {}
            : { referenceAnswer: testCase.referenceAnswer.trim() }),
          criteria: testCase.criteria.map((criterion) => ({
            id: criterion.id.trim(),
            description: criterion.description.trim(),
          })),
          assertions: {
            outputContains: nonEmptyLines(testCase.outputContains),
            outputNotContains: nonEmptyLines(testCase.outputNotContains),
            tools: [],
          },
          mocks: [],
        })),
      },
    },
  };
}

function agentDatasets(project: PragmaProjectSnapshot): PragmaAgentJudgeEvaluationResource[] {
  return project.resources.filter(
    (resource): resource is PragmaAgentJudgeEvaluationResource =>
      resource.kind === "Evaluation" && resource.spec.method.type === "agent-judge",
  );
}

function datasetTemplate(id: string): string {
  return `apiVersion: pragma/v5
kind: Evaluation
metadata:
  id: ${id}
  name: Tool Calling Basics
  description: Checks whether an agent selects and uses the right tool.
  tags: [agent, tool-calling]
spec:
  method:
    type: agent-judge
    group: Agent Tool Calling
    execution:
      mode: mock
    cases:
      - id: lookup_customer
        name: Look up a customer
        prompt: Find customer C-100 and summarize their status.
        criteria:
          - id: correct_answer
            description: The answer accurately summarizes the fixture result.
        assertions:
          outputContains: []
          outputNotContains: []
          tools:
            - name: get_customer
              minCalls: 1
              maxCalls: 1
              inputMatches:
                id: C-100
        mocks:
          - name: get_customer
            outcomes:
              - expectInput:
                  id: C-100
                output:
                  id: C-100
                  status: active
`;
}
