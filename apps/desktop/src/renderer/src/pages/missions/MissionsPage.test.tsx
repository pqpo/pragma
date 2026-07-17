import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { PragmaResource } from "@pragma/interpreter/ast";

import type { Mission } from "../../../../shared/desktop-api.ts";
import { CreateMissionFragment, MissionDetailFragment, MissionsPage } from "./MissionsPage.tsx";

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

  it("preselects an expert requested from Studio", () => {
    const expert: PragmaResource = {
      apiVersion: "pragma/v2",
      kind: "Expert",
      metadata: {
        id: "test_expert",
        version: "0.1.0",
        name: "Test Expert",
        description: "Handles focused test work.",
        tags: [],
      },
      spec: {
        scope: "testing",
        runtime: { ref: "runtime-profile:test@1.0.0" },
        capabilities: [],
        toolApprovals: {},
        contextStores: [],
        plugins: [],
        tools: [],
      },
    };
    const html = renderToStaticMarkup(
      <CreateMissionFragment
        executors={[expert]}
        initialExecutorRef="expert:test_expert@0.1.0"
        onCreated={() => undefined}
      />,
    );

    expect(html).toContain(
      '<option value="expert:test_expert@0.1.0" selected="">Test Expert · expert</option>',
    );
  });
});

describe("MissionDetailFragment", () => {
  it("uses the full detail width for a single expert", () => {
    const html = renderToStaticMarkup(<MissionDetailFragment mission={missionFixture("expert")} />);

    expect(html).toContain(">Chat<");
    expect(html).toContain("mission-chat-scroll");
    expect(html).toContain("mission-chat-footer");
    expect(html).toContain("mission-chat-composer");
    expect(html).not.toContain("mission-execution-notice");
    expect(html).not.toContain("Pinned to");
  });

  it("keeps team conversations in the shared chat surface", () => {
    const html = renderToStaticMarkup(<MissionDetailFragment mission={missionFixture("team")} />);

    expect(html).toContain("Team channel");
    expect(html).toContain("mission-chat-composer");
    expect(html).not.toContain("mission-team-inspector");
  });

  it("replaces the send action with an interrupt action while an execution is active", () => {
    const mission = missionFixture("expert");
    mission.execution = {
      id: "00000000-0000-4000-8000-000000000010",
      sessionId: "00000000-0000-4000-8000-000000000011",
      environmentFingerprint: "a".repeat(64),
      status: "running",
      startedAt: "2026-07-11T00:00:01.000Z",
    };
    const html = renderToStaticMarkup(<MissionDetailFragment mission={mission} />);

    expect(html).toContain('aria-label="Interrupt execution"');
    expect(html).not.toContain('aria-label="Send message"');
    expect(html).not.toContain("Execution running");
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
    messages: [],
    lifecycleStatus: "active",
    createdAt: "2026-07-11T00:00:00.000Z",
    updatedAt: "2026-07-11T00:00:00.000Z",
  };
}
