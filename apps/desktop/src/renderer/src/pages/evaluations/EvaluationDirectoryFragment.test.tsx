import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";

import {
  activateEvaluationDirectory,
  EvaluationDirectoryFragment,
  evaluationsForTarget,
} from "./EvaluationDirectoryFragment.tsx";
import { createEmptyFlow } from "../studio/flow-editor/flow-model.ts";

describe("EvaluationDirectoryFragment", () => {
  it("remains active after React StrictMode replays its effect", () => {
    const mounted = { current: false };

    const firstCleanup = activateEvaluationDirectory(mounted);
    expect(mounted.current).toBe(true);
    firstCleanup();
    expect(mounted.current).toBe(false);

    const secondCleanup = activateEvaluationDirectory(mounted);
    expect(mounted.current).toBe(true);
    secondCleanup();
    expect(mounted.current).toBe(false);
  });

  it("groups targets beside the selected Flow's Run Dry suites", () => {
    const flow = {
      ...createEmptyFlow("8h9j0k1m2n3p4q5r"),
      metadata: {
        id: "8h9j0k1m2n3p4q5r",
        name: "Release flow",
        description: "Release a build.",
        tags: [],
      },
    };
    const secondFlow = {
      ...createEmptyFlow("6h7j8k9m0n1p2q3r"),
      metadata: {
        id: "6h7j8k9m0n1p2q3r",
        name: "Rollback flow",
        description: "Roll back a release.",
        tags: [],
      },
    };
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "studio",
      revision: 1,
      diagnostics: [],
      resources: [
        flow,
        secondFlow,
        {
          apiVersion: "pragma/v3",
          kind: "Evaluation",
          metadata: {
            id: "7h8j9k0m1n2p3q4r",
            name: "Release Run Dry",
            description: "Covers the release flow.",
            tags: ["run-dry"],
          },
          spec: {
            target: { ref: "flow:8h9j0k1m2n3p4q5r" },
            method: {
              type: "flow-run-dry",
              cases: [
                {
                  id: "release",
                  name: "Release",
                  input: {},
                  mocks: {},
                  expect: { status: "succeeded", path: [] },
                },
              ],
            },
          },
        },
      ],
    } satisfies PragmaProjectSnapshot;
    const evaluations = project.resources.filter((resource) => resource.kind === "Evaluation");

    expect(evaluationsForTarget(evaluations, flow)).toHaveLength(1);
    expect(evaluationsForTarget(evaluations, secondFlow)).toHaveLength(0);

    const html = renderToStaticMarkup(
      <EvaluationDirectoryFragment
        project={project}
        onCreate={() => undefined}
        onOpen={() => undefined}
        onRun={async () => ({
          passed: true,
          summary: { total: 0, passed: 0, failed: 0 },
          coverage: { required: [], covered: [], missing: [], passed: true },
          cases: [],
        })}
      />,
    );

    expect(html).toContain("Evaluations");
    expect(html).toContain("Release Run Dry");
    expect(html).toContain("Evaluation targets");
    expect(html).toContain("Run Dry cases");
    expect(html).toContain("Release flow");
    expect(html).toContain("Rollback flow");
    expect(html).toContain("1 case");
    expect(html).not.toContain("Dataset + LLM-as-Judge");
  });
});
