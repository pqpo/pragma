import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PragmaAgentJudgeEvaluationResource } from "@pragma/evaluation/ast";
import type { PragmaExpertResource, PragmaExpertTeamResource } from "@pragma/interpreter/ast";

import type {
  AgentEvaluationRun,
  EvaluationQueueSettings,
  DesktopRuntimeAvailability,
  PragmaProjectSnapshot,
} from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";

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
  readonly onProjectChange: (project: PragmaProjectSnapshot) => void;
}) {
  const { t } = useTranslation("studio");
  const datasets = agentDatasets(props.project);
  const [source, setSource] = useState("");
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    try {
      const { id } = await window.pragmaDesktop.allocatePragmaResourceId();
      setSource(datasetTemplate(id));
      setEditing(true);
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const next = await window.pragmaDesktop.importAgentEvaluationDatasetYaml({
        baseRevision: props.project.revision,
        source,
      });
      props.onProjectChange(next);
      setEditing(false);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="agent-evaluation-page-section">
      <header className="agent-evaluation-section-heading">
        <div>
          <h1>{t("agentEvaluation.datasets")}</h1>
          <p>{t("agentEvaluation.datasetsDescription")}</p>
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={busy}
          onClick={() => void begin()}
        >
          {t("agentEvaluation.newDataset")}
        </button>
      </header>
      {editing ? (
        <div className="agent-evaluation-yaml-editor">
          <label>
            <span>{t("agentEvaluation.yamlSource")}</span>
            <textarea
              value={source}
              spellCheck={false}
              onChange={(event) => setSource(event.target.value)}
            />
          </label>
          <div>
            <button className="secondary-button" type="button" onClick={() => setEditing(false)}>
              {t("agentEvaluation.cancel")}
            </button>
            <button
              className="primary-button"
              type="button"
              disabled={busy}
              onClick={() => void save()}
            >
              {t("agentEvaluation.saveDataset")}
            </button>
          </div>
        </div>
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
        <p className="studio-empty-copy">{t("agentEvaluation.noDatasets")}</p>
      ) : null}
      {error !== null ? <p className="form-error">{error}</p> : null}
    </section>
  );
}

export function AgentEvaluationQueue() {
  const { t } = useTranslation("studio");
  const [runs, setRuns] = useState<AgentEvaluationRun[]>([]);
  const [settings, setSettings] = useState<EvaluationQueueSettings | null>(null);
  const [runtimes, setRuntimes] = useState<readonly DesktopRuntimeAvailability[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const settingsUpdateRef = useRef(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      try {
        const [nextRuns, nextSettings, nextRuntimes] = await Promise.all([
          window.pragmaDesktop.listAgentEvaluationRuns(),
          window.pragmaDesktop.getEvaluationQueueSettings(),
          window.pragmaDesktop.getRuntimeAvailability(),
        ]);
        if (!active) return;
        setRuns(nextRuns);
        setSettings(nextSettings);
        setRuntimes(nextRuntimes);
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

  const updateConcurrency = async (concurrency: number) => {
    if (settings === null || settingsUpdateRef.current) return;
    settingsUpdateRef.current = true;
    setSettingsBusy(true);
    try {
      setSettings(
        await window.pragmaDesktop.updateEvaluationQueueSettings({
          expectedRevision: settings.revision,
          concurrency,
        }),
      );
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      settingsUpdateRef.current = false;
      setSettingsBusy(false);
    }
  };
  const models = useMemo(
    () =>
      runtimes.flatMap((runtime) =>
        runtime.status !== "available"
          ? []
          : (runtime.models ?? []).map((model) => ({
              key: `${runtime.id}\0${model.provider.id}\0${model.id}`,
              label: `${runtime.displayName} · ${model.provider.displayName} · ${model.displayName}`,
            })),
      ),
    [runtimes],
  );
  const judgeModelKey =
    settings?.judge.mode === "pinned"
      ? `${settings.judge.model.runtimeId}\0${settings.judge.model.providerId}\0${settings.judge.model.modelId}`
      : "";
  const updateJudge = async (key: string) => {
    if (settings === null || settingsUpdateRef.current) return;
    const [runtimeId, providerId, modelId] = key.split("\0");
    settingsUpdateRef.current = true;
    setSettingsBusy(true);
    try {
      setSettings(
        await window.pragmaDesktop.updateEvaluationQueueSettings({
          expectedRevision: settings.revision,
          judge:
            key === ""
              ? { mode: "inherit-default" }
              : {
                  mode: "pinned",
                  model: { runtimeId: runtimeId!, providerId: providerId!, modelId: modelId! },
                },
        }),
      );
      setError(null);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      settingsUpdateRef.current = false;
      setSettingsBusy(false);
    }
  };

  return (
    <section className="agent-evaluation-page-section">
      <header className="agent-evaluation-section-heading">
        <div>
          <h1>{t("agentEvaluation.queue")}</h1>
          <p>{t("agentEvaluation.queueDescription")}</p>
        </div>
        <div className="agent-evaluation-settings-inline">
          <div className="agent-evaluation-field">
            <span>{t("agentEvaluation.judgeModel")}</span>
            <SelectMenu
              ariaLabel={t("agentEvaluation.judgeModel")}
              value={judgeModelKey}
              options={[
                { value: "", label: t("agentEvaluation.inheritDefault") },
                ...models.map((model) => ({ value: model.key, label: model.label })),
              ]}
              disabled={settings === null || settingsBusy}
              onChange={(value) => void updateJudge(value)}
            />
          </div>
          <div className="agent-evaluation-field agent-evaluation-concurrency">
            <span>{t("agentEvaluation.concurrency")}</span>
            <SelectMenu
              ariaLabel={t("agentEvaluation.concurrency")}
              value={String(settings?.concurrency ?? 3)}
              options={Array.from({ length: 16 }, (_, index) => ({
                value: String(index + 1),
                label: String(index + 1),
              }))}
              disabled={settings === null || settingsBusy}
              onChange={(value) => void updateConcurrency(Number(value))}
            />
          </div>
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
          <p className="studio-empty-copy">{t("agentEvaluation.noRuns")}</p>
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
                      onClick={() =>
                        void window.pragmaDesktop.retryAgentEvaluationTask({
                          id: selected.id,
                          caseId: task.caseId,
                        })
                      }
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
                onClick={() =>
                  void window.pragmaDesktop.cancelAgentEvaluationRun({ id: selected.id })
                }
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

function agentDatasets(project: PragmaProjectSnapshot): PragmaAgentJudgeEvaluationResource[] {
  return project.resources.filter(
    (resource): resource is PragmaAgentJudgeEvaluationResource =>
      resource.kind === "Evaluation" && resource.spec.method.type === "agent-judge",
  );
}

function datasetTemplate(id: string): string {
  return `apiVersion: pragma/v4
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
