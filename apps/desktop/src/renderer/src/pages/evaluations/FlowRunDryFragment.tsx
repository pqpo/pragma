import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  ArrowLeft,
  CheckCircle,
  GitBranch,
  Play,
  Plus,
  Trash,
  XCircle,
} from "@phosphor-icons/react";
import {
  PragmaFlowRunDryEvaluationResourceSchema,
  PragmaFlowRunDrySuiteSchema,
  type PragmaFlowRunDryEvaluationResource,
  type PragmaFlowRunDryCase,
  type PragmaFlowRunDrySuite,
  type PragmaFlowRunDrySuiteResult,
} from "@pragma/evaluation/ast";
import type { PragmaFlowResource } from "@pragma/interpreter/ast";

import { SelectMenu } from "../../components/SelectMenu.tsx";
import { errorMessage } from "../../lib/errors.ts";
import { StudioConfirmationDialog } from "../studio/StudioDialog.tsx";
import { StudioScreenFrame } from "../studio/StudioScreenFrame.tsx";

interface RunDryCaseDraft {
  readonly key: string;
  readonly id: string;
  readonly name: string;
  readonly input: string;
  readonly mocks: string;
  readonly status: "succeeded" | "failed";
  readonly path: string;
  readonly output: string;
  readonly errorContains: string;
}

export function FlowRunDryFragment(props: {
  readonly evaluation: PragmaFlowRunDryEvaluationResource;
  readonly flows: readonly PragmaFlowResource[];
  readonly onBack: () => void;
  readonly onSave: (evaluation: PragmaFlowRunDryEvaluationResource) => Promise<void>;
  readonly onRun: (
    evaluation: PragmaFlowRunDryEvaluationResource,
  ) => Promise<PragmaFlowRunDrySuiteResult>;
}) {
  const { t } = useTranslation("studio");
  const [drafts, setDrafts] = useState<readonly RunDryCaseDraft[]>(
    props.evaluation.spec.method.cases.map(caseToDraft),
  );
  const [name, setName] = useState(props.evaluation.metadata.name);
  const [description, setDescription] = useState(props.evaluation.metadata.description);
  const [selectedKey, setSelectedKey] = useState<string | null>(drafts[0]?.key ?? null);
  const [result, setResult] = useState<PragmaFlowRunDrySuiteResult | null>(null);
  const [busy, setBusy] = useState<"save" | "run" | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [deleteKey, setDeleteKey] = useState<string | null>(null);
  const selected = drafts.find((draft) => draft.key === selectedKey) ?? null;
  const targetFlow = props.flows.find(
    (flow) => `flow:${flow.metadata.id}` === props.evaluation.spec.target.ref,
  );
  const pendingDelete = drafts.find((draft) => draft.key === deleteKey) ?? null;

  const updateSelected = (patch: Partial<RunDryCaseDraft>) => {
    if (selected === null) return;
    setDrafts((current) =>
      current.map((draft) => (draft.key === selected.key ? { ...draft, ...patch } : draft)),
    );
    setResult(null);
  };
  const addCase = () => {
    const next = emptyCaseDraft(drafts.length + 1);
    setDrafts((current) => [...current, next]);
    setSelectedKey(next.key);
    setResult(null);
    setFormError(null);
  };
  const removeCase = (key: string) => {
    const index = drafts.findIndex((draft) => draft.key === key);
    if (index === -1) return;
    const next = drafts.filter((draft) => draft.key !== key);
    setDrafts(next);
    if (selectedKey === key) {
      setSelectedKey(next[Math.min(index, next.length - 1)]?.key ?? null);
    }
    setResult(null);
    setDeleteKey(null);
  };
  const materialize = (): PragmaFlowRunDrySuite => {
    const cases = drafts.map(draftToCase);
    return PragmaFlowRunDrySuiteSchema.parse({ cases });
  };
  const materializeEvaluation = (): PragmaFlowRunDryEvaluationResource =>
    PragmaFlowRunDryEvaluationResourceSchema.parse({
      ...props.evaluation,
      metadata: {
        ...props.evaluation.metadata,
        name: name.trim(),
        description: description.trim(),
      },
      spec: {
        target: props.evaluation.spec.target,
        method: { type: "flow-run-dry", cases: materialize().cases },
      },
    });
  const run = async () => {
    setBusy("run");
    setFormError(null);
    try {
      setResult(await props.onRun(materializeEvaluation()));
    } catch (cause) {
      setResult(null);
      setFormError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };
  const save = async () => {
    setBusy("save");
    setFormError(null);
    try {
      await props.onSave(materializeEvaluation());
    } catch (cause) {
      setFormError(errorMessage(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <StudioScreenFrame
      className="flow-run-dry"
      labelledBy="flow-run-dry-heading"
      header={
        <button className="back-link" type="button" onClick={props.onBack}>
          <ArrowLeft size={18} aria-hidden="true" />
          {t("backEvaluations")}
        </button>
      }
    >
      <header className="studio-heading flow-run-dry-heading">
        <h1 id="flow-run-dry-heading">{t("runDryTitle")}</h1>
        <div className="detail-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={busy !== null}
            onClick={() => void run()}
          >
            <Play size={17} aria-hidden="true" />
            {busy === "run" ? t("runningRunDry") : t("runAllCases")}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={busy !== null}
            onClick={() => void save()}
          >
            {busy === "save" ? t("saving") : t("saveCases")}
          </button>
        </div>
      </header>
      <p className="flow-run-dry-description">{t("runDryDescription")}</p>

      <section
        className="flow-run-dry-editor flow-run-dry-identity"
        aria-label={t("evaluationIdentity")}
      >
        <div className="flow-run-dry-form-grid">
          <label>
            <span>{t("evaluationName")}</span>
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <div className="flow-run-dry-static-field">
            <span>{t("evaluationTarget")}</span>
            <div className="flow-run-dry-static-value">
              <GitBranch size={17} aria-hidden="true" />
              <strong>{targetFlow?.metadata.name ?? props.evaluation.spec.target.ref}</strong>
            </div>
          </div>
        </div>
        <label>
          <span>{t("description")}</span>
          <textarea
            rows={3}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
      </section>

      <section className="flow-run-dry-coverage" aria-label={t("runDryCoverage")}>
        <div>
          <strong>{t("runDryCases")}</strong>
          <span>{drafts.length}</span>
        </div>
        <div>
          <strong>{t("requiredTransitions")}</strong>
          <span>{result?.coverage.required.length ?? "—"}</span>
        </div>
        <div>
          <strong>{t("coverageStatus")}</strong>
          <span>
            {result === null
              ? t("notRun")
              : result.coverage.passed
                ? t("coverageComplete")
                : t("coverageMissing", { count: result.coverage.missing.length })}
          </span>
        </div>
      </section>

      <div className="flow-run-dry-workspace">
        <aside className="flow-run-dry-cases" aria-label={t("runDryCases")}>
          {drafts.map((draft) => {
            const caseResult = result?.cases.find((candidate) => candidate.id === draft.id);
            const caseName = draft.name.trim() || t("untitledCase");
            return (
              <div
                className={`flow-run-dry-case-item${draft.key === selectedKey ? " is-active" : ""}`}
                key={draft.key}
              >
                <button
                  className="flow-run-dry-case-select"
                  type="button"
                  onClick={() => setSelectedKey(draft.key)}
                >
                  {caseResult?.passed === true ? (
                    <CheckCircle size={18} weight="fill" aria-hidden="true" />
                  ) : caseResult === undefined ? (
                    <Play size={18} aria-hidden="true" />
                  ) : (
                    <XCircle size={18} weight="fill" aria-hidden="true" />
                  )}
                  <span>
                    <strong>{caseName}</strong>
                    <small>{draft.id.trim() || t("missingCaseId")}</small>
                  </span>
                </button>
                <button
                  className="flow-run-dry-case-delete"
                  type="button"
                  aria-label={t("deleteCaseNamed", { name: caseName })}
                  title={t("deleteCaseNamed", { name: caseName })}
                  onClick={() => setDeleteKey(draft.key)}
                >
                  <Trash size={16} aria-hidden="true" />
                </button>
              </div>
            );
          })}
          {drafts.length === 0 ? <p>{t("noRunDryCases")}</p> : null}
          <button
            className="secondary-button flow-run-dry-add-case"
            type="button"
            onClick={addCase}
          >
            <Plus size={17} aria-hidden="true" />
            {t("addRunDryCase")}
          </button>
        </aside>

        {selected === null ? (
          <section className="flow-run-dry-empty">
            <h2>{t("noCaseSelected")}</h2>
            <p>{t("addCaseToStart")}</p>
          </section>
        ) : (
          <section
            className="flow-run-dry-editor flow-run-dry-case-editor"
            aria-label={t("editRunDryCase")}
          >
            <header>
              <div>
                <h2>{selected.name.trim() || t("untitledCase")}</h2>
                <p>{t("runDryCaseHint")}</p>
              </div>
            </header>
            <div className="flow-run-dry-form-grid">
              <label>
                <span>{t("caseId")}</span>
                <input
                  value={selected.id}
                  onChange={(event) => updateSelected({ id: event.target.value })}
                />
              </label>
              <label>
                <span>{t("caseName")}</span>
                <input
                  value={selected.name}
                  onChange={(event) => updateSelected({ name: event.target.value })}
                />
              </label>
            </div>
            <label>
              <span>{t("caseInputJson")}</span>
              <textarea
                className="code-input"
                rows={5}
                spellCheck={false}
                value={selected.input}
                onChange={(event) => updateSelected({ input: event.target.value })}
              />
            </label>
            <label>
              <span>{t("caseMocksJson")}</span>
              <textarea
                className="code-input"
                rows={10}
                spellCheck={false}
                value={selected.mocks}
                onChange={(event) => updateSelected({ mocks: event.target.value })}
              />
              <small>{t("caseMocksHint")}</small>
            </label>
            <div className="flow-run-dry-form-grid">
              <div className="flow-run-dry-select-field">
                <span>{t("expectedStatus")}</span>
                <SelectMenu<RunDryCaseDraft["status"]>
                  ariaLabel={t("expectedStatus")}
                  className="form-select"
                  value={selected.status}
                  options={[
                    { value: "succeeded", label: t("statusSucceeded") },
                    { value: "failed", label: t("statusFailed") },
                  ]}
                  onChange={(status) =>
                    updateSelected({
                      status,
                      ...(status === "failed" ? { output: "" } : { errorContains: "" }),
                    })
                  }
                />
              </div>
              <label>
                <span>{t("expectedPath")}</span>
                <input
                  value={selected.path}
                  placeholder="draft, review, publish"
                  onChange={(event) => updateSelected({ path: event.target.value })}
                />
              </label>
            </div>
            {selected.status === "succeeded" ? (
              <label>
                <span>{t("expectedOutputJson")}</span>
                <textarea
                  className="code-input"
                  rows={5}
                  spellCheck={false}
                  placeholder={t("optionalAssertion")}
                  value={selected.output}
                  onChange={(event) => updateSelected({ output: event.target.value })}
                />
              </label>
            ) : (
              <label>
                <span>{t("expectedErrorContains")}</span>
                <input
                  value={selected.errorContains}
                  onChange={(event) => updateSelected({ errorContains: event.target.value })}
                />
              </label>
            )}
          </section>
        )}
      </div>

      {formError ? (
        <p className="form-error" role="alert">
          {formError}
        </p>
      ) : null}
      {result !== null ? <RunDryResult result={result} /> : null}
      {pendingDelete !== null ? (
        <StudioConfirmationDialog
          title={t("deleteRunDryCaseTitle")}
          description={t("deleteRunDryCaseDescription", {
            name: pendingDelete.name.trim() || t("untitledCase"),
          })}
          cancelLabel={t("cancel")}
          confirmLabel={t("deleteCase")}
          busyLabel={t("deleting")}
          busy={false}
          onCancel={() => setDeleteKey(null)}
          onConfirm={() => removeCase(pendingDelete.key)}
        />
      ) : null}
    </StudioScreenFrame>
  );
}

function RunDryResult(props: { readonly result: PragmaFlowRunDrySuiteResult }) {
  const { t } = useTranslation("studio");
  return (
    <section
      className={
        props.result.passed ? "flow-run-dry-result is-success" : "flow-run-dry-result is-error"
      }
      aria-label={t("runDryResult")}
    >
      <header>
        {props.result.passed ? (
          <CheckCircle size={22} weight="fill" aria-hidden="true" />
        ) : (
          <XCircle size={22} weight="fill" aria-hidden="true" />
        )}
        <div>
          <h2>{props.result.passed ? t("allCasesPassed") : t("runDryNeedsWork")}</h2>
          <p>
            {t("runDrySummary", {
              passed: props.result.summary.passed,
              total: props.result.summary.total,
            })}
          </p>
        </div>
      </header>
      {props.result.coverage.missing.length > 0 ? (
        <div>
          <strong>{t("missingTransitions")}</strong>
          <code>{props.result.coverage.missing.join(", ")}</code>
        </div>
      ) : null}
      <div className="flow-run-dry-result-cases">
        {props.result.cases.map((testCase) => (
          <article key={testCase.id}>
            <strong>{testCase.name}</strong>
            <span>{testCase.path.join(" → ")}</span>
            {testCase.assertions
              .filter((assertion) => !assertion.passed)
              .map((assertion) => (
                <p key={assertion.kind}>{assertion.message}</p>
              ))}
            {testCase.error !== undefined ? <p>{testCase.error}</p> : null}
          </article>
        ))}
      </div>
    </section>
  );
}

function caseToDraft(testCase: PragmaFlowRunDryCase): RunDryCaseDraft {
  return {
    key: crypto.randomUUID(),
    id: testCase.id,
    name: testCase.name,
    input: prettyJson(testCase.input),
    mocks: prettyJson(testCase.mocks),
    status: testCase.expect.status,
    path: testCase.expect.path.join(", "),
    output: testCase.expect.output === undefined ? "" : prettyJson(testCase.expect.output),
    errorContains: testCase.expect.errorContains ?? "",
  };
}

function emptyCaseDraft(index: number): RunDryCaseDraft {
  return {
    key: crypto.randomUUID(),
    id: `case_${index}`,
    name: `Case ${index}`,
    input: "{}",
    mocks: "{}",
    status: "succeeded",
    path: "",
    output: "",
    errorContains: "",
  };
}

function draftToCase(draft: RunDryCaseDraft): PragmaFlowRunDryCase {
  const output = draft.output.trim();
  const errorContains = draft.errorContains.trim();
  return {
    id: draft.id.trim(),
    name: draft.name.trim(),
    input: parseJson(draft.input, "input"),
    mocks: parseJson(draft.mocks, "mocks") as PragmaFlowRunDryCase["mocks"],
    expect: {
      status: draft.status,
      path: draft.path
        .split(",")
        .map((stepId) => stepId.trim())
        .filter((stepId) => stepId.length > 0),
      ...(draft.status === "succeeded" && output !== ""
        ? { output: parseJson(output, "expected output") }
        : {}),
      ...(draft.status === "failed" && errorContains !== "" ? { errorContains } : {}),
    },
  };
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new Error(`Invalid ${label} JSON.`);
  }
}

function prettyJson(value: unknown): string {
  return JSON.stringify(value, null, 2);
}
