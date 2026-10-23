import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MissionSchema, MissionRepositorySummarySchema } from "@pragma/shared";
import type { MissionSummary } from "../../../../shared/contracts/index.ts";
import { MissionsPage, resolveMissionsPageInitialState } from "./MissionsPage.tsx";
import { missionToSummary } from "./mission-page-utils.ts";
import {
  MissionWorkspaceTabs,
  EMPTY_MISSION_WORKSPACE_TABS,
  visibleMissionWorkspaces,
  addMissionWorkspaceTab,
  closeMissionWorkspaceTab,
  missionMatchesWorkspace,
  missionWorkspaces,
} from "./mission-workspace-tabs.tsx";

import { i18n } from "../../i18n/index.ts";

afterEach(async () => {
  await i18n.changeLanguage("en");
});

const summary = (path: string, basename: string, id = path): MissionSummary => ({
  id,
  title: basename,
  workspace: { path, basename },
  executor: { kind: "expert", name: "Pragma" },
  source: { type: "task" },
  lifecycleStatus: "active",
  updatedAt: "2026-10-22T00:00:00.000Z",
});

describe("Mission workspace categories", () => {
  it.each([
    ["en", "Default workspace"],
    ["zh-Hans", "默认工作区"],
    ["zh-Hant", "預設工作區"],
  ])("names the default workspace tab and close control in %s", async (locale, label) => {
    await i18n.changeLanguage(locale);
    const workspace = { path: "/pragma/workspace", basename: "workspace" };
    const html = renderToStaticMarkup(
      <MissionWorkspaceTabs
        missions={[
          summary(workspace.path, workspace.basename),
          summary("/other/workspace", "workspace"),
        ]}
        value={workspace.path}
        state={addMissionWorkspaceTab(EMPTY_MISSION_WORKSPACE_TABS, workspace)}
        defaultWorkspacePath={workspace.path}
        onStateChange={() => undefined}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain(`<span>${label}</span>`);
    expect(html).toContain(i18n.t("closeWorkspaceTab", { ns: "missions", name: label }));
    expect(html).toContain("<span>workspace</span>");
  });

  it("names an unopened default workspace in the add menu", () => {
    const html = renderToStaticMarkup(
      <MissionWorkspaceTabs
        missions={[]}
        value={null}
        state={EMPTY_MISSION_WORKSPACE_TABS}
        defaultWorkspacePath="/pragma/workspace"
        knownWorkspaces={[{ path: "/pragma/workspace", basename: "workspace" }]}
        onStateChange={() => undefined}
        onChange={() => undefined}
      />,
    );
    expect(html).toContain("Default workspace");
    expect(html).not.toContain('title="workspace"');
  });

  it("opens only active workspace tabs by default across all task sources", () => {
    const missions = [
      summary("/a", "Alpha"),
      { ...summary("/b", "Beta"), lifecycleStatus: "completed" as const },
      {
        ...summary("/c", "Charlie"),
        source: { type: "automation" as const, automationRef: "automation:0000000000000000" },
      },
    ];
    expect(
      visibleMissionWorkspaces(missions, EMPTY_MISSION_WORKSPACE_TABS).map(
        (workspace) => workspace.path,
      ),
    ).toEqual(["/a", "/c"]);
    expect(missionWorkspaces(missions, "en").map((workspace) => workspace.path)).toEqual([
      "/a",
      "/b",
      "/c",
    ]);
  });

  it("keeps closed tabs hidden on task updates, and restores them by adding", () => {
    const workspace = { path: "/a", basename: "Alpha" };
    const closed = closeMissionWorkspaceTab(EMPTY_MISSION_WORKSPACE_TABS, workspace.path);
    expect(
      visibleMissionWorkspaces([summary("/a", "Alpha"), summary("/a", "Alpha", "new")], closed),
    ).toEqual([]);
    const added = addMissionWorkspaceTab(closed, workspace);
    expect(visibleMissionWorkspaces([], added)).toEqual([workspace]);
    expect(addMissionWorkspaceTab(added, workspace).addedWorkspaces).toEqual([workspace]);
    const reclosed = closeMissionWorkspaceTab(added, workspace.path);
    expect(visibleMissionWorkspaces([], reclosed)).toEqual([]);
    expect(reclosed.addedWorkspaces).toEqual([workspace]);
    expect(visibleMissionWorkspaces([], addMissionWorkspaceTab(reclosed, workspace))).toEqual([
      workspace,
    ]);
  });

  it("offers only unopened workspaces for adding, including recent and completed-task workspaces", () => {
    const html = renderToStaticMarkup(
      <MissionWorkspaceTabs
        missions={[
          summary("/a", "Alpha"),
          { ...summary("/b", "Beta"), lifecycleStatus: "completed" },
        ]}
        value="/a"
        state={EMPTY_MISSION_WORKSPACE_TABS}
        onStateChange={() => undefined}
        onChange={() => undefined}
        knownWorkspaces={[{ path: "/recent", basename: "Recent" }]}
      />,
    );
    const menu = html.slice(html.indexOf('class="ui-select-menu'));
    expect(html).toContain('aria-label="Add workspace tab"');
    expect(menu).not.toContain('title="Alpha"');
    expect(menu).toContain('title="Beta"');
    expect(menu).toContain('title="Recent"');
    expect(menu).toContain("Choose another folder");
    expect(menu).not.toContain('aria-selected="true"');
    expect(html).toContain('aria-label="Close Alpha tab"');
  });

  it("deduplicates by full path, keeps same-name directories separate, and sorts by name", () => {
    const missions = [
      summary("/z", "workspace"),
      summary("/b/Desktop", "Desktop"),
      summary("/a/Desktop", "Desktop"),
      summary("/z", "workspace"),
      summary("/expert-mesh", "expert-mesh"),
    ];
    expect(missionWorkspaces(missions, "en").map((workspace) => workspace.path)).toEqual([
      "/a/Desktop",
      "/b/Desktop",
      "/expert-mesh",
      "/z",
    ]);
    expect(missions.filter((mission) => missionMatchesWorkspace(mission, "/a/Desktop"))).toEqual([
      missions[2],
    ]);
    expect(missions.filter((mission) => missionMatchesWorkspace(mission, null))).toEqual(missions);
  });

  it("keeps the all-workspaces control first and icon-only, with one keyboard entry point", () => {
    const html = renderToStaticMarkup(
      <MissionWorkspaceTabs
        missions={[summary("/z", "Zebra"), summary("/a", "Alpha")]}
        state={EMPTY_MISSION_WORKSPACE_TABS}
        onStateChange={() => undefined}
        value="/a"
        onChange={() => undefined}
      />,
    );
    expect(html.indexOf("mission-workspace-all")).toBeLessThan(html.indexOf(">Alpha<"));
    expect(html.indexOf(">Alpha<")).toBeLessThan(html.indexOf(">Zebra<"));
    expect(html).toContain('aria-label="All workspaces"');
    expect(html).not.toContain(">All workspaces</button>");
    expect(html.match(/role="tab"/g)).toHaveLength(3);
    expect(html.match(/role="tab"[^>]*tabindex="0"/g)).toHaveLength(1);
    expect(html.match(/role="tab" aria-selected="true"/g)).toHaveLength(1);
  });

  it("applies workspace and source filters to the real task rail", () => {
    const missions = [
      summary("/a", "Alpha", "alpha-task"),
      summary("/b", "Beta", "beta-task"),
      {
        ...summary("/a", "Alpha", "alpha-automation"),
        source: { type: "automation" as const, automationRef: "automation:0000000000000000" },
      },
    ];
    const memoryState = {
      missions,
      selectedMission: null,
      selectedMissionId: null,
      workspacePath: "/a",
    };
    expect(resolveMissionsPageInitialState({ memoryState }).workspacePath).toBe("/a");
    const render = (workspacePath: string | null, activeSource: "task" | "automation") =>
      renderToStaticMarkup(
        <MissionsPage
          onCreate={() => undefined}
          initialMemoryState={{ ...memoryState, workspacePath, activeSource }}
        />,
      );
    const scoped = render("/a", "task");
    expect(scoped).toContain('data-mission-id="alpha-task"');
    expect(scoped).not.toContain('data-mission-id="beta-task"');
    expect(scoped).not.toContain('data-mission-id="alpha-automation"');
    expect(render(null, "task")).toContain('data-mission-id="beta-task"');
    expect(render("/a", "automation")).toContain('data-mission-id="alpha-automation"');
    expect(render("/b", "automation")).not.toContain('class="mission-row');
  });

  it("preserves workspace identity through both the summary schema and live detail updates", () => {
    const value = summary("/a/Desktop", "Desktop", "00000000-0000-4000-8000-000000000001");
    expect(MissionRepositorySummarySchema.parse(value).workspace).toEqual(value.workspace);
    // Read projections remain compatible with clients that omit the additive path field.
    const old = { ...value, workspace: { basename: "Desktop" } };
    expect(MissionRepositorySummarySchema.parse(old).workspace).toEqual(old.workspace);
    expect(missionWorkspaces([old, value], "en")).toEqual([value.workspace]);
    expect(missionMatchesWorkspace(old, null)).toBe(true);
    expect(missionMatchesWorkspace(old, "/a/Desktop")).toBe(false);
    expect(
      missionToSummary(
        MissionSchema.parse({
          ...value,
          schemaVersion: "pragma.mission/v11",
          origin: { type: "user" },
          goal: "Inspect workspace grouping",
          initialMessageId: "00000000-0000-4000-8000-000000000002",
          toolPermissionMode: "request-approval",
          project: { id: "studio", revision: 1 },
          contextMounts: [],
          executor: { kind: "expert", name: "Pragma", ref: "expert:v2vt1v01vzz6j24q" },
          createdAt: value.updatedAt,
        }),
      ).workspace,
    ).toEqual(value.workspace);
  });
});
