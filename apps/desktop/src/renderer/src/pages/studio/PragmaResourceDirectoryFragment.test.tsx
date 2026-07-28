import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  type PragmaFlowResource,
  type PragmaExpertResource,
} from "@pragma/interpreter/ast";
import type { PragmaProjectSnapshot } from "../../../../shared/contracts/index.ts";

import {
  matchingTeamExperts,
  PragmaResourceDetailFragment,
  PragmaResourceDirectoryFragment,
  TeamEditor,
} from "./PragmaResourceDirectoryFragment.tsx";
import { createEmptyFlow } from "./flow-editor/flow-model.ts";

function expert(index: number): PragmaExpertResource {
  const id = String(index).padStart(16, "0");
  return PragmaExpertResourceSchema.parse({
    apiVersion: "pragma/v3",
    kind: "Expert",
    metadata: {
      id,
      name: `Expert ${String(index).padStart(3, "0")}`,
      description: `Specialist description ${index}`,
      tags: index === 99 ? ["needle"] : [],
    },
    spec: { scope: "general", instructions: "General expert." },
  });
}

describe("expert team editor", () => {
  it("keeps large expert collections behind two compact picker triggers", () => {
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: Array.from({ length: 100 }, (_, index) => expert(index)),
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <TeamEditor
        project={project}
        error={null}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
    expect(html).not.toContain("Expert 099");
    expect(html).not.toContain("<fieldset");
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain('class="secondary-button"');
  });

  it("limits the default list and searches names, ids, descriptions, and tags", () => {
    const experts = Array.from({ length: 100 }, (_, index) => expert(index));
    const selectedRef = "expert:0000000000000099";

    expect(matchingTeamExperts(experts, "", new Set())).toHaveLength(8);
    expect(matchingTeamExperts(experts, "", new Set([selectedRef]))[0]?.metadata.id).toBe(
      "0000000000000099",
    );
    expect(
      matchingTeamExperts(experts, "0000000000000042", new Set()).map((item) => item.metadata.id),
    ).toEqual(["0000000000000042"]);
    expect(
      matchingTeamExperts(experts, "description 42", new Set()).map((item) => item.metadata.id),
    ).toEqual(["0000000000000042"]);
    expect(
      matchingTeamExperts(experts, "needle", new Set()).map((item) => item.metadata.id),
    ).toEqual(["0000000000000099"]);
  });

  it("shows and preserves optional Team instructions", () => {
    const experts = [expert(1), expert(2)];
    const instructions = "Verify evidence before declaring work complete.";
    const initial = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "ExpertTeam",
      metadata: {
        id: "cccvf3nab91n2wja",
        name: "Quality team",
        description: "Coordinates quality work",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:0000000000000001" },
        members: [{ ref: "expert:0000000000000002" }],
        instructions,
        delegation: {},
      },
    });
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [...experts, initial],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <TeamEditor
        project={project}
        initial={initial}
        mode="edit"
        error={null}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(html).toContain("Team instructions (optional)");
    expect(html).toContain(instructions);
    expect(html).toContain("always-on TEAM.md");
    expect(html).not.toContain("Version");
    expect(html).toContain("pragma-resource-editor-header");
    expect(html).not.toContain("canonical Pragma YAML");
  });
});

describe("PragmaResourceDirectoryFragment", () => {
  it("opens Team resources through a detail-first directory row", () => {
    const initial = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "ExpertTeam",
      metadata: {
        id: "cccvf3nab91n2wja",
        name: "Quality team",
        description: "Coordinates quality work",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:0000000000000001" },
        members: [{ ref: "expert:0000000000000002" }],
        delegation: {},
      },
    });
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [initial],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <PragmaResourceDirectoryFragment
        kind="team"
        project={project}
        onOpen={() => undefined}
        onCreate={() => undefined}
      />,
    );

    expect(html).toContain("Quality team");
    expect(html).toContain('class="studio-asset-row pragma-resource-row"');
    expect(html).not.toContain("Edit expert team");
    expect(html).not.toContain("Validate &amp; publish");
  });
});

describe("PragmaResourceDetailFragment", () => {
  it("shows Team details with edit and delete actions", () => {
    const experts = [expert(1), expert(2)];
    const team = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v3",
      kind: "ExpertTeam",
      metadata: {
        id: "cccvf3nab91n2wja",
        name: "Quality team",
        description: "Coordinates quality work",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:0000000000000001" },
        members: [{ ref: "expert:0000000000000002" }],
        instructions: "Check evidence.",
        delegation: { maxConcurrency: 2, maxDepth: 5 },
      },
    });
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [...experts, team],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <PragmaResourceDetailFragment
        resource={team}
        project={project}
        onBack={() => undefined}
        onEdit={() => undefined}
        onRunDry={() => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(html).toContain("Back to teams");
    expect(html).toContain("Edit expert team");
    expect(html).toContain("Quality team");
    expect(html).toContain("Expert 001");
    expect(html).toContain("2 members");
    expect(html).toContain("Delete");
  });

  it("shows Flow details before opening the Flow editor", () => {
    const flow: PragmaFlowResource = {
      ...createEmptyFlow("ffdfk2cczgqjda7q"),
      metadata: {
        id: "ffdfk2cczgqjda7q",
        name: "Approval flow",
        description: "Coordinates approval.",
        tags: [],
      },
      spec: {
        limits: { maxNodeVisits: 20 },
        graph: {
          start: "approval",
          steps: {
            approval: { action: { ref: "action:approval@1.0.0" } },
          },
          loops: {},
          transitions: { approval: { end: true } },
        },
      },
    };
    const project = {
      schemaVersion: "pragma.project-snapshot/v3",
      projectId: "test-project",
      revision: 0,
      resources: [flow],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <PragmaResourceDetailFragment
        resource={flow}
        project={project}
        onBack={() => undefined}
        onEdit={() => undefined}
        onRunDry={() => undefined}
        onDelete={async () => undefined}
      />,
    );

    expect(html).toContain("Back to flows");
    expect(html).toContain("Edit flow");
    expect(html).toContain("Approval flow");
    expect(html).toContain("approval");
    expect(html).toContain("1 step");
    expect(html).toContain("1 transition");
    expect(html).not.toContain("Flow editor");
  });
});
