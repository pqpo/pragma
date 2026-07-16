import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { Mission } from "../../../../shared/desktop-api.ts";
import { MissionDetailFragment, MissionsPage } from "./MissionsPage.tsx";

describe("MissionsPage", () => {
  it("presents mission creation as an AI prompt card with scoped capability entries", () => {
    const html = renderToStaticMarkup(<MissionsPage />);

    expect(html).toContain("Start a mission");
    expect(html).toContain('aria-label="Mission context and tools"');
    expect(html).toContain(">Context<");
    expect(html).toContain(">Files<");
    expect(html).toContain(">Knowledge<");
    expect(html).toContain(">Tools<");
    expect(html.match(/aria-disabled="true"/g)?.length).toBe(3);
  });
});

describe("MissionDetailFragment", () => {
  it("uses the full detail width for a single expert", () => {
    const html = renderToStaticMarkup(<MissionDetailFragment mission={missionFixture("expert")} />);

    expect(html).toContain(">Chat<");
    expect(html).toContain("Ready to run");
    expect(html).not.toContain("mission-team-inspector");
  });

  it("shows the expert inspector only for a team executor", () => {
    const html = renderToStaticMarkup(<MissionDetailFragment mission={missionFixture("team")} />);

    expect(html).toContain("Team channel");
    expect(html).toContain("mission-team-inspector");
    expect(html).toContain("Team members will appear here.");
  });
});

function missionFixture(kind: "expert" | "team"): Mission {
  return {
    schemaVersion: "pragma.mission/v2",
    id: "00000000-0000-4000-8000-000000000000",
    title: "Missions page design",
    goal: "Design the Missions page.",
    workspace: { path: "/workspace/expert-mesh", basename: "expert-mesh" },
    project: { id: "studio", revision: 1 },
    executor: {
      kind,
      ref: kind === "expert" ? "expert:product_designer@0.1.0" : "team:delivery_team@0.1.0",
      name: kind === "expert" ? "Product Designer" : "Delivery Team",
      version: "0.1.0",
    },
    lifecycleStatus: "active",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}
