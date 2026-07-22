import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import {
  PragmaExpertResourceSchema,
  PragmaExpertTeamResourceSchema,
  type PragmaExpertResource,
} from "@pragma/interpreter/ast";
import type { PragmaProjectSnapshot } from "../../../../shared/desktop-api.ts";

import { matchingTeamExperts, TeamEditor } from "./PragmaResourceDirectoryFragment.tsx";

function expert(index: number): PragmaExpertResource {
  const id = `expert_${String(index).padStart(3, "0")}`;
  return PragmaExpertResourceSchema.parse({
    apiVersion: "pragma/v2",
    kind: "Expert",
    metadata: {
      id,
      version: "1.0.0",
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
      schemaVersion: "pragma.project-snapshot/v2",
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
    const selectedRef = "expert:expert_099@1.0.0";

    expect(matchingTeamExperts(experts, "", new Set())).toHaveLength(8);
    expect(matchingTeamExperts(experts, "", new Set([selectedRef]))[0]?.metadata.id).toBe(
      "expert_099",
    );
    expect(
      matchingTeamExperts(experts, "expert_042", new Set()).map((item) => item.metadata.id),
    ).toEqual(["expert_042"]);
    expect(
      matchingTeamExperts(experts, "description 42", new Set()).map((item) => item.metadata.id),
    ).toEqual(["expert_042"]);
    expect(
      matchingTeamExperts(experts, "needle", new Set()).map((item) => item.metadata.id),
    ).toEqual(["expert_099"]);
  });

  it("shows and preserves optional Team instructions", () => {
    const experts = [expert(1), expert(2)];
    const instructions = "Verify evidence before declaring work complete.";
    const initial = PragmaExpertTeamResourceSchema.parse({
      apiVersion: "pragma/v2",
      kind: "ExpertTeam",
      metadata: {
        id: "quality_team",
        version: "1.0.0",
        name: "Quality team",
        description: "Coordinates quality work",
        tags: [],
      },
      spec: {
        coordinator: { ref: "expert:expert_001@1.0.0" },
        members: [{ ref: "expert:expert_002@1.0.0" }],
        instructions,
        delegation: {},
      },
    });
    const project = {
      schemaVersion: "pragma.project-snapshot/v2",
      projectId: "test-project",
      revision: 0,
      resources: [...experts, initial],
      diagnostics: [],
    } satisfies PragmaProjectSnapshot;

    const html = renderToStaticMarkup(
      <TeamEditor
        project={project}
        initial={initial}
        error={null}
        onCancel={() => undefined}
        onSave={async () => undefined}
      />,
    );

    expect(html).toContain("Team instructions (optional)");
    expect(html).toContain(instructions);
    expect(html).toContain("always-on TEAM.md");
  });
});
