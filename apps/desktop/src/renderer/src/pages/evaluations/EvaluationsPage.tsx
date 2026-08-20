import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PragmaFlowRunDryEvaluationResource } from "@pragma/evaluation/ast";
import { canonicalPragmaResourceRef, type PragmaFlowResource } from "@pragma/interpreter/ast";
import type { PragmaExpertResource, PragmaExpertTeamResource } from "@pragma/interpreter/ast";

import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";
import { errorMessage } from "../../lib/errors.ts";
import { EvaluationDirectoryFragment } from "./EvaluationDirectoryFragment.tsx";
import { FlowRunDryFragment } from "./FlowRunDryFragment.tsx";
import {
  AgentEvaluationDatasets,
  AgentEvaluationQueue,
  AgentEvaluationRunSetup,
} from "./AgentEvaluationWorkspace.tsx";

type EvaluationSecondaryView = "datasets" | "queue";

export function createFlowRunDryEvaluation(
  resourceId: string,
  flow: PragmaFlowResource,
): PragmaFlowRunDryEvaluationResource {
  return {
    apiVersion: "pragma/v5",
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

export function EvaluationsPage(
  props: {
    readonly initialTargetId?: string | undefined;
    readonly onTargetChange?: ((targetId: string) => void) | undefined;
  } = {},
) {
  const { t } = useTranslation("common");
  const [project, setProject] = useState<PragmaProjectSnapshot | null>(null);
  const [selectedTargetId, setSelectedTargetId] = useState(props.initialTargetId ?? "");
  const [draft, setDraft] = useState<PragmaFlowRunDryEvaluationResource | null>(null);
  const [runTarget, setRunTarget] = useState<
    PragmaExpertResource | PragmaExpertTeamResource | null
  >(null);
  const [secondaryView, setSecondaryView] = useState<EvaluationSecondaryView | null>(null);
  const [secondaryReturnFocus, setSecondaryReturnFocus] = useState<EvaluationSecondaryView | null>(
    null,
  );
  const [error, setError] = useState<string | null>(null);

  const selectTargetId = (targetId: string) => {
    setSelectedTargetId(targetId);
    props.onTargetChange?.(targetId);
  };

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

  const save = async (evaluation: PragmaFlowRunDryEvaluationResource) => {
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
        <p className="studio-empty-copy evaluations-page-loading">{t("actions.loading")}</p>
      ) : null}
      {project !== null ? (
        <EvaluationDirectoryFragment
          project={project}
          onCreate={(resourceId, flow) => {
            setSecondaryView(null);
            setDraft(createFlowRunDryEvaluation(resourceId, flow));
          }}
          onOpen={(evaluation) => {
            setSecondaryView(null);
            setDraft(evaluation);
          }}
          onCreateAgentEvaluation={(target) => {
            setSecondaryView(null);
            setDraft(null);
            setRunTarget(target);
          }}
          onSelectTarget={() => {
            setSecondaryView(null);
            setDraft(null);
            setRunTarget(null);
          }}
          selectedTargetId={selectedTargetId}
          onSelectedTargetIdChange={selectTargetId}
          onOpenDatasets={() => {
            setDraft(null);
            setRunTarget(null);
            setSecondaryReturnFocus(null);
            setSecondaryView("datasets");
          }}
          onOpenQueue={() => {
            setDraft(null);
            setRunTarget(null);
            setSecondaryReturnFocus(null);
            setSecondaryView("queue");
          }}
          focusAction={secondaryReturnFocus}
          onFocusActionHandled={() => setSecondaryReturnFocus(null)}
          onDelete={async (evaluation) => {
            const api = typeof window === "undefined" ? undefined : window.pragmaDesktop;
            if (api === undefined) throw new Error("Desktop bridge is unavailable.");
            const snapshot = await api.deletePragmaResource({
              baseRevision: project.revision,
              ref: canonicalPragmaResourceRef(evaluation),
            });
            setProject(snapshot);
          }}
          detail={
            secondaryView === "datasets" ? (
              <AgentEvaluationDatasets
                project={project}
                onBack={() => {
                  setSecondaryView(null);
                  setSecondaryReturnFocus("datasets");
                }}
                onProjectChange={setProject}
              />
            ) : secondaryView === "queue" ? (
              <AgentEvaluationQueue
                onBack={() => {
                  setSecondaryView(null);
                  setSecondaryReturnFocus("queue");
                }}
              />
            ) : runTarget !== null ? (
              <AgentEvaluationRunSetup
                project={project}
                target={runTarget}
                onBack={() => setRunTarget(null)}
                onCreated={() => {
                  setRunTarget(null);
                  setSecondaryView("queue");
                }}
              />
            ) : draft === null ? undefined : (
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
            )
          }
          detailLabelledBy={
            secondaryView === "datasets"
              ? "agent-evaluation-datasets-heading"
              : secondaryView === "queue"
                ? "agent-evaluation-queue-heading"
                : runTarget !== null
                  ? "agent-evaluation-run-heading"
                  : draft === null
                    ? undefined
                    : "flow-run-dry-heading"
          }
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
