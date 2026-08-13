import { PragmaAgentJudgeEvaluationResourceSchema } from "@pragma/evaluation/ast";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";

import {
  AgentEvaluationDatasets,
  AgentEvaluationQueue,
  createDatasetCaseDraft,
  createDatasetCriterionDraft,
  createDatasetForm,
  datasetFormIsValid,
  datasetFromForm,
} from "./AgentEvaluationWorkspace.tsx";

const emptyProject = {
  schemaVersion: "pragma.project-snapshot/v3",
  projectId: "studio",
  revision: 1,
  diagnostics: [],
  resources: [],
} satisfies PragmaProjectSnapshot;

describe("agent evaluation secondary pages", () => {
  it("provides an explicit route back to the selected target", () => {
    const datasetsHtml = renderToStaticMarkup(
      createElement(AgentEvaluationDatasets, {
        project: emptyProject,
        onBack: () => undefined,
        onProjectChange: () => undefined,
      }),
    );
    const queueHtml = renderToStaticMarkup(
      createElement(AgentEvaluationQueue, { onBack: () => undefined }),
    );

    expect(datasetsHtml).toContain("Back to target");
    expect(datasetsHtml).toContain("autofocus");
    expect(datasetsHtml).toContain('aria-labelledby="agent-evaluation-datasets-heading"');
    expect(queueHtml).toContain("Back to target");
    expect(queueHtml).toContain("autofocus");
    expect(queueHtml).toContain('aria-labelledby="agent-evaluation-queue-heading"');
  });
});

function completeForm() {
  const form = createDatasetForm();
  return {
    ...form,
    name: "Support quality",
    description: "Checks whether support answers are correct.",
    group: "support",
    cases: form.cases.map((testCase) => ({
      ...testCase,
      name: "Account lookup",
      prompt: "Find the active account.",
      criteria: testCase.criteria.map((criterion) => ({
        ...criterion,
        description: "Returns the active account.",
      })),
    })),
  };
}

describe("agent evaluation dataset form", () => {
  it("generates unique criterion IDs when criteria are appended", () => {
    const form = completeForm();
    const testCase = form.cases[0];
    if (testCase === undefined) throw new Error("Expected a test case.");

    const additional = createDatasetCriterionDraft(testCase.criteria);
    const next = {
      ...form,
      cases: [
        {
          ...testCase,
          criteria: [
            ...testCase.criteria,
            { ...additional, description: "Does not return a suspended account." },
          ],
        },
      ],
    };

    expect(next.cases[0]?.criteria.map((criterion) => criterion.id)).toEqual([
      "correct_answer",
      "criterion_1",
    ]);
    expect(datasetFormIsValid(next)).toBe(true);
    expect(() =>
      PragmaAgentJudgeEvaluationResourceSchema.parse(datasetFromForm("7h8j9k0m1n2p3q4r", next)),
    ).not.toThrow();
  });

  it("reuses an available case suffix without colliding after a deletion", () => {
    const first = createDatasetCaseDraft();
    const second = createDatasetCaseDraft([first]);
    const third = createDatasetCaseDraft([first, second]);
    const replacement = createDatasetCaseDraft([first, third]);

    expect([first.id, third.id, replacement.id]).toEqual(["case_1", "case_3", "case_2"]);
  });

  it("rejects duplicate case and criterion IDs before serialization", () => {
    const form = completeForm();
    const first = form.cases[0];
    if (first === undefined) throw new Error("Expected a test case.");
    const duplicateCase = { ...first, key: "duplicate-case" };
    expect(datasetFormIsValid({ ...form, cases: [first, duplicateCase] })).toBe(false);

    const criterion = first.criteria[0];
    if (criterion === undefined) throw new Error("Expected a criterion.");
    expect(
      datasetFormIsValid({
        ...form,
        cases: [
          {
            ...first,
            criteria: [criterion, { ...criterion, key: "duplicate-criterion" }],
          },
        ],
      }),
    ).toBe(false);
  });
});
