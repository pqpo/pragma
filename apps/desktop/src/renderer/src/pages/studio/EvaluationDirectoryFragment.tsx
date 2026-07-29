import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CaretRight, Plus, Scales, TestTube } from "@phosphor-icons/react";
import type { PragmaEvaluationResource } from "@pragma/evaluation/ast";
import { canonicalPragmaResourceRef, type PragmaFlowResource } from "@pragma/interpreter/ast";

import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { StudioScreenFrame } from "./StudioScreenFrame.tsx";
import { desktopApi } from "./studio-model.ts";

export function activateEvaluationDirectory(mounted: { current: boolean }): () => void {
  mounted.current = true;

  return () => {
    mounted.current = false;
  };
}

export function EvaluationDirectoryFragment(props: {
  readonly project: PragmaProjectSnapshot;
  readonly onOpen: (evaluation: PragmaEvaluationResource) => void;
  readonly onCreate: (resourceId: string, flow: PragmaFlowResource) => void;
}) {
  const { t } = useTranslation("studio");
  const [error, setError] = useState<string | null>(null);
  const [allocating, setAllocating] = useState(false);
  const mountedRef = useRef(false);
  useEffect(() => activateEvaluationDirectory(mountedRef), []);
  const evaluations = props.project.resources.filter(
    (resource): resource is PragmaEvaluationResource => resource.kind === "Evaluation",
  );
  const flows = props.project.resources.filter(
    (resource): resource is PragmaFlowResource => resource.kind === "Flow",
  );
  const [newTargetRef, setNewTargetRef] = useState(
    flows[0] === undefined ? "" : `flow:${flows[0].metadata.id}`,
  );
  const newTarget = flows.find((flow) => `flow:${flow.metadata.id}` === newTargetRef) ?? null;
  const flowName = (ref: string) =>
    flows.find((flow) => `flow:${flow.metadata.id}` === ref)?.metadata.name ?? ref;

  return (
    <StudioScreenFrame
      className="studio-collection pragma-resource-directory"
      labelledBy="evaluations-heading"
      header={
        <header className="studio-heading">
          <div>
            <h1 id="evaluations-heading">{t("evaluations")}</h1>
            <p>{t("evaluationsDescription")}</p>
          </div>
          <div className="evaluation-create-controls">
            <label>
              <span>{t("evaluationTarget")}</span>
              <select
                value={newTarget === null ? "" : `flow:${newTarget.metadata.id}`}
                disabled={flows.length === 0}
                onChange={(event) => setNewTargetRef(event.target.value)}
              >
                <option value="" disabled>
                  {t("selectEvaluationTarget")}
                </option>
                {flows.map((flow) => (
                  <option key={flow.metadata.id} value={`flow:${flow.metadata.id}`}>
                    {flow.metadata.name}
                  </option>
                ))}
              </select>
            </label>
            <button
              className="primary-button"
              type="button"
              disabled={newTarget === null || allocating}
              onClick={() => {
                const api = desktopApi();
                if (api === undefined || newTarget === null || allocating) return;
                setAllocating(true);
                setError(null);
                void api
                  .allocatePragmaResourceId()
                  .then(({ id }) => {
                    if (!mountedRef.current) return;
                    setAllocating(false);
                    props.onCreate(id, newTarget);
                  })
                  .catch((cause: unknown) => {
                    if (!mountedRef.current) return;
                    setAllocating(false);
                    setError(errorMessage(cause));
                  });
              }}
            >
              <Plus size={17} aria-hidden="true" />
              {allocating ? t("creatingEvaluation") : t("newRunDryEvaluation")}
            </button>
          </div>
        </header>
      }
    >
      <section className="evaluation-methods" aria-label={t("evaluationMethods")}>
        <article>
          <TestTube size={24} aria-hidden="true" />
          <div>
            <strong>{t("runDry")}</strong>
            <span>{t("runDryMethodDescription")}</span>
          </div>
        </article>
        <article className="is-disabled">
          <Scales size={24} aria-hidden="true" />
          <div>
            <strong>{t("llmJudge")}</strong>
            <span>{t("llmJudgeDescription")}</span>
          </div>
          <em>{t("comingSoon")}</em>
        </article>
      </section>
      {flows.length === 0 ? <p className="studio-empty-copy">{t("evaluationNeedsFlow")}</p> : null}
      <div className="studio-asset-rows">
        {evaluations.map((evaluation) => (
          <button
            className="studio-asset-row pragma-resource-row"
            type="button"
            key={canonicalPragmaResourceRef(evaluation)}
            onClick={() => props.onOpen(evaluation)}
          >
            <span className="studio-asset-icon" aria-hidden="true">
              <TestTube size={24} />
            </span>
            <span className="studio-asset-copy">
              <strong>{evaluation.metadata.name}</strong>
              <span>
                {flowName(evaluation.spec.target.ref)} ·{" "}
                {t("evaluationCaseCount", {
                  count: evaluation.spec.method.cases.length,
                })}
              </span>
            </span>
            <CaretRight size={17} aria-hidden="true" />
          </button>
        ))}
        {evaluations.length === 0 ? (
          <p className="studio-empty-copy">{t("noEvaluationsYet")}</p>
        ) : null}
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </StudioScreenFrame>
  );
}
