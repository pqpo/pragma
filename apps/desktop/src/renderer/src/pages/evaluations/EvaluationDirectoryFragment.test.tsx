import { PRAGMA_DSL_WRITE_API_VERSION } from "@pragma/interpreter/ast";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
} from "@pragma/interpreter/ast";
import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";

import {
  activateEvaluationDirectory,
  defaultEvaluationTargetId,
  EvaluationDirectoryFragment,
  evaluationsForTarget,
} from "./EvaluationDirectoryFragment.tsx";
import { createEmptyFlow } from "../studio/flow-editor/flow-model.ts";

describe("EvaluationDirectoryFragment", () => {
  it("defaults to the first expert before teams and flows", () => {
    const expert = PragmaExpertResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id: "1h2j3k4m5n6p7q8r",
        name: "First expert",
        description: "The first selectable expert.",
        tags: [],
      },
      spec: { scope: "general", instructions: "Help." },
    });
    const flow = createEmptyFlow("8h9j0k1m2n3p4q5r");

    expect(defaultEvaluationTargetId([expert], [], [flow])).toBe(expert.metadata.id);
    expect(defaultEvaluationTargetId([], [], [flow])).toBe(flow.metadata.id);
  });

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
          apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
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
        selectedTargetId={flow.metadata.id}
        onSelectedTargetIdChange={() => undefined}
        onCreate={() => undefined}
        onDelete={async () => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(html).toContain('<h1 id="evaluations-heading">Release flow</h1>');
    expect(html).not.toContain('<h1 id="evaluations-heading">Evaluations</h1>');
    expect(html).not.toContain("Create repeatable quality checks for every executable object.");
    expect(html).toContain("Release Run Dry");
    expect(html).toContain("Evaluation targets");
    expect(html).toContain('aria-label="Resize navigation"');
    expect(html).not.toContain("<h3>Run Dry cases</h3>");
    expect(html).toContain("Release flow");
    expect(html).toContain("Rollback flow");
    expect(html).toContain("1 case");
    expect(html).toContain('class="evaluation-target-directory"');
    expect(html).toContain('class="evaluation-directory-main"');
    expect(html).not.toContain('class="studio-screen evaluation-directory"');
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("New Run Dry case");
    expect(html).not.toContain("Run all");
    expect(html).not.toContain("Dataset + LLM-as-Judge");

    const emptyHtml = renderToStaticMarkup(
      <EvaluationDirectoryFragment
        project={{ ...project, resources: [flow] }}
        selectedTargetId={flow.metadata.id}
        onSelectedTargetIdChange={() => undefined}
        onCreate={() => undefined}
        onDelete={async () => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(emptyHtml).toContain("New case");
    expect(emptyHtml).toContain('class="evaluation-target-empty-icon"');
    expect(emptyHtml).not.toContain("<h2>No evaluations yet.</h2>");
    expect(emptyHtml).not.toContain("Run all");

    const detailHtml = renderToStaticMarkup(
      <EvaluationDirectoryFragment
        project={project}
        selectedTargetId={flow.metadata.id}
        onSelectedTargetIdChange={() => undefined}
        detail={<h1 id="evaluation-detail-heading">Evaluation detail</h1>}
        detailLabelledBy="evaluation-detail-heading"
        onCreate={() => undefined}
        onDelete={async () => undefined}
        onOpen={() => undefined}
      />,
    );

    expect(detailHtml).toContain('aria-labelledby="evaluation-detail-heading"');
    expect(detailHtml).toContain('class="evaluation-target-directory"');
    expect(detailHtml).toContain("Evaluation targets");
    expect(detailHtml).toContain("Evaluation detail");
    expect(detailHtml).not.toContain('id="evaluations-heading"');
  });

  it("shows dataset and queue entrances only for agent targets", () => {
    const expert = PragmaExpertResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "Expert",
      metadata: {
        id: "1h2j3k4m5n6p7q8r",
        name: "Project manager",
        description: "Coordinates delivery.",
        tags: [],
      },
      spec: { scope: "general", instructions: "Coordinate the project." },
    });
    const team = PragmaExpertTeamResourceSchema.parse({
      apiVersion: PRAGMA_DSL_WRITE_API_VERSION,
      kind: "ExpertTeam",
      metadata: {
        id: "2h3j4k5m6n7p8q9r",
        name: "Delivery team",
        description: "Coordinates specialists.",
        tags: [],
      },
      spec: {
        coordinator: { ref: `expert:${expert.metadata.id}` },
        members: [{ ref: `expert:${expert.metadata.id}` }],
        delegation: {},
      },
    });
    const callbacks = {
      onCreate: () => undefined,
      onDelete: async () => undefined,
      onOpen: () => undefined,
      onOpenDatasets: () => undefined,
      onOpenQueue: () => undefined,
    };

    const expertHtml = renderToStaticMarkup(
      <EvaluationDirectoryFragment
        {...callbacks}
        selectedTargetId={expert.metadata.id}
        onSelectedTargetIdChange={() => undefined}
        project={{
          schemaVersion: "pragma.project-snapshot/v3",
          projectId: "studio",
          revision: 1,
          diagnostics: [],
          resources: [expert, team],
        }}
      />,
    );

    expect(expertHtml).toContain("Start evaluation");
    expect(expertHtml).toContain(">Datasets</button>");
    expect(expertHtml).toContain(">Queue</button>");
    expect(expertHtml).toContain('class="evaluation-target-actions"');
    expect(expertHtml).not.toContain("Dataset + LLM-as-Judge");

    const teamHtml = renderToStaticMarkup(
      <EvaluationDirectoryFragment
        {...callbacks}
        selectedTargetId={team.metadata.id}
        onSelectedTargetIdChange={() => undefined}
        project={{
          schemaVersion: "pragma.project-snapshot/v3",
          projectId: "studio",
          revision: 1,
          diagnostics: [],
          resources: [team],
        }}
      />,
    );

    expect(teamHtml).toContain("Start evaluation");
    expect(teamHtml).toContain(">Datasets</button>");
    expect(teamHtml).toContain(">Queue</button>");

    const flow = createEmptyFlow("8h9j0k1m2n3p4q5r");
    const flowHtml = renderToStaticMarkup(
      <EvaluationDirectoryFragment
        {...callbacks}
        selectedTargetId={flow.metadata.id}
        onSelectedTargetIdChange={() => undefined}
        project={{
          schemaVersion: "pragma.project-snapshot/v3",
          projectId: "studio",
          revision: 1,
          diagnostics: [],
          resources: [flow],
        }}
      />,
    );

    expect(flowHtml).toContain("New");
    expect(flowHtml).not.toContain(">Datasets</button>");
    expect(flowHtml).not.toContain(">Queue</button>");
  });
});
