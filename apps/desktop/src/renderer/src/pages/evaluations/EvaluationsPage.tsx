import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PragmaEvaluationResource } from "@pragma/evaluation/ast";
import { canonicalPragmaResourceRef, type PragmaFlowResource } from "@pragma/interpreter/ast";

import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { EvaluationDirectoryFragment } from "./EvaluationDirectoryFragment.tsx";
import { FlowRunDryFragment } from "./FlowRunDryFragment.tsx";

export function createFlowRunDryEvaluation(
  resourceId: string,
  flow: PragmaFlowResource,
): PragmaEvaluationResource {
  return {
    apiVersion: "pragma/v3",
    kind: "Evaluation",
    metadata: {
      id: resourceId,
      name: `${flow.metadata.name} Run Dry`,
      description: `Run Dry evaluation for ${flow.metadata.name}.`,
      tags: ["run-dry"],
    },
    spec: {
      target: { ref: `flow:${flow.metadata.id}` },
      method: {
        type: "flow-run-dry",
        cases: [
          {
            id: "case_1",
            name: "Case 1",
            input: {},
            mocks: {},
            expect: { status: "succeeded", path: [] },
          },
        ],
      },
    },
  };
}

export function EvaluationsPage() {
  const { t } = useTranslation("common");
  const [project, setProject] = useState<PragmaProjectSnapshot | null>(null);
  const [draft, setDraft] = useState<PragmaEvaluationResource | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = typeof window === "undefined" ? undefined : window.pragmaDesktop;
    if (api === undefined) return;
    let cancelled = false;

    void api
      .getPragmaProject()
      .then((snapshot) => {
        if (cancelled) return;
        setProject(snapshot);
        setError(null);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(errorMessage(cause));
      });

    return () => {
      cancelled = true;
    };
  }, []);

  const save = async (evaluation: PragmaEvaluationResource) => {
    if (project === null) return;
    const api = typeof window === "undefined" ? undefined : window.pragmaDesktop;
    if (api === undefined) throw new Error("Desktop bridge is unavailable.");
    const ref = canonicalPragmaResourceRef(evaluation);
    const exists = project.resources.some(
      (resource) => canonicalPragmaResourceRef(resource) === ref,
    );
    const snapshot = await api.upsertPragmaResource({
      baseRevision: project.revision,
      resource: evaluation,
      requiredUnchangedRefs: exists ? [ref] : [],
    });
    setProject(snapshot);
    setDraft(evaluation);
    setError(null);
  };

  return (
    <section className="evaluations-page" aria-busy={project === null && error === null}>
      {project === null && error === null ? (
        <p className="studio-empty-copy">{t("actions.loading")}</p>
      ) : null}
      {project !== null && draft === null ? (
        <EvaluationDirectoryFragment
          project={project}
          onCreate={(resourceId, flow) => setDraft(createFlowRunDryEvaluation(resourceId, flow))}
          onOpen={setDraft}
          onRun={async (evaluation) => {
            const api = typeof window === "undefined" ? undefined : window.pragmaDesktop;
            if (api === undefined) throw new Error("Desktop bridge is unavailable.");
            return await api.runPragmaEvaluation({ evaluation });
          }}
        />
      ) : null}
      {project !== null && draft !== null ? (
        <FlowRunDryFragment
          key={`${draft.metadata.id}:${project.revision}`}
          evaluation={draft}
          flows={project.resources.filter(
            (resource): resource is PragmaFlowResource => resource.kind === "Flow",
          )}
          onBack={() => setDraft(null)}
          onRun={async (evaluation) => {
            const api = typeof window === "undefined" ? undefined : window.pragmaDesktop;
            if (api === undefined) throw new Error("Desktop bridge is unavailable.");
            return await api.runPragmaEvaluation({ evaluation });
          }}
          onSave={save}
        />
      ) : null}
      {error !== null ? (
        <p className="form-error evaluations-page-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}
