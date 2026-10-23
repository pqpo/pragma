import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { HomeProject } from "../../../../shared/contracts/index.ts";
import { readHomeDraft, writeHomeDraft } from "../../lib/home-draft.ts";
import { ContextStorePickerDialog } from "../../components/ContextStorePickerDialog.tsx";
import { WorkspacePicker } from "../../components/WorkspacePicker.tsx";
import { HomeProjects } from "./HomeProjects.tsx";
import { HomePage } from "./HomePage.tsx";
import { MissionsPage } from "../missions/MissionsPage.tsx";
import { MissionSchema } from "@pragma/shared";
import { MissionWorkspaceTabs } from "../missions/mission-workspace-tabs.tsx";
import {
  EMPTY_MISSION_WORKSPACE_TABS,
  addMissionWorkspaceTab,
  closeMissionWorkspaceTab,
  reconcileMissionWorkspaceTabs,
  writeMissionWorkspaceTabs,
  readMissionWorkspaceTabs,
  type MissionWorkspaceTabState,
} from "../../lib/mission-workspace-tabs-preference.ts";
import { MissionRail } from "../missions/mission-rail.tsx";

// Drive Home hook lifecycles without a DOM and inspect the Mission and draft boundaries.
const hooks = vi.hoisted(() => {
  type Slot = {
    value?: unknown;
    current?: unknown;
    deps?: readonly unknown[] | undefined;
    callback?: unknown;
    cleanup?: (() => void) | undefined;
  };
  const slots: Slot[] = [];
  let cursor = 0;
  let dirty = false;
  const effects: Array<() => void> = [];
  const equal = (a?: readonly unknown[], b?: readonly unknown[]) =>
    a !== undefined &&
    b !== undefined &&
    a.length === b.length &&
    a.every((value, index) => Object.is(value, b[index]));
  return {
    reset() {
      slots.length = 0;
      effects.length = 0;
      cursor = 0;
      dirty = false;
    },
    begin() {
      cursor = 0;
      dirty = false;
    },
    commit() {
      effects.splice(0).forEach((effect) => effect());
    },
    dirty: () => dirty,
    unmount() {
      slots.forEach((slot) => slot.cleanup?.());
    },
    useState<T>(initial?: T | (() => T)) {
      const index = cursor++;
      const slot = (slots[index] ??= {
        value: typeof initial === "function" ? (initial as () => T)() : initial,
      });
      return [
        slot.value as T,
        (value: T | ((previous: T) => T)) => {
          slot.value =
            typeof value === "function" ? (value as (previous: T) => T)(slot.value as T) : value;
          dirty = true;
        },
      ] as const;
    },
    useRef<T>(initial: T) {
      return (slots[cursor++] ??= { current: initial }) as { current: T };
    },
    useCallback<T>(callback: T, deps: readonly unknown[]) {
      const index = cursor++;
      if (!equal(slots[index]?.deps, deps)) slots[index] = { callback, deps };
      return slots[index]!.callback as T;
    },
    useEffect(effect: () => void | (() => void), deps?: readonly unknown[]) {
      const index = cursor++;
      if (equal(slots[index]?.deps, deps)) return;
      const previous = slots[index];
      const slot = (slots[index] = { deps, cleanup: previous?.cleanup });
      effects.push(() => {
        slot.cleanup?.();
        slot.cleanup = effect() ?? undefined;
      });
    },
  };
});

vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useId: () => "workspace-tabs-test",
  useState: hooks.useState,
  useRef: hooks.useRef,
  useCallback: hooks.useCallback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: hooks.useEffect,
  useLayoutEffect: hooks.useEffect,
}));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t, i18n: { language: "en" } }) };
});

function renderer(component: () => ReactNode) {
  let tree: ReactNode;
  let mounted = true;
  const render = () => {
    hooks.begin();
    tree = component();
    hooks.commit();
  };
  render();
  return {
    async flush() {
      for (let i = 0; i < 10; i++) {
        await Promise.resolve();
        if (mounted && hooks.dirty()) render();
      }
    },
    props(match: (props: Record<string, unknown>, type: unknown) => boolean) {
      const find = (node: ReactNode): Record<string, unknown> | undefined => {
        if (Array.isArray(node)) {
          for (const child of node) {
            const found = find(child);
            if (found) return found;
          }
        } else if (isValidElement<Record<string, unknown>>(node)) {
          if (match(node.props, node.type)) return node.props;
          return (
            find(node.props.children as ReactNode) ??
            find(node.props.header as ReactNode) ??
            find(node.props.footer as ReactNode)
          );
        }
        return undefined;
      };
      const result = find(tree);
      if (!result) throw new Error("Home control not found");
      return result;
    },
    unmount() {
      mounted = false;
      hooks.unmount();
    },
  };
}

beforeEach(() => {
  hooks.reset();
  vi.stubGlobal("window", new EventTarget());
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const executorRef = "expert:3sfd30h5017wd17d";
const storeIds = ["11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222"];
const workspace = { path: "/workspace/project", basename: "project" };
const project: HomeProject = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Project",
  executorRef,
  workspace,
  contextStoreIds: storeIds,
};

function fixture(projects: readonly HomeProject[] = [project]) {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
  };
  const createMission = vi.fn().mockResolvedValue({ id: "mission-id" });
  vi.stubGlobal("window", {
    localStorage: storage,
    setInterval,
    clearInterval,
    pragmaDesktop: {
      listHomeProjects: async () => projects,
      listContextStores: async () => storeIds.map((id) => ({ id, name: id })),
      getBridgeSnapshot: async () => ({ app: { version: "1.0.0" } }),
      getHomeMissionExecutorCatalog: async () => ({
        executors: [executorRef, "expert:0000000000000001"].map((ref) => ({
          ref,
          kind: "expert",
          name: "Expert",
          preference: { favoriteScope: "none", hidden: false },
          teamMemberships: [],
          tags: [],
        })),
        defaults: {
          executorRef,
          workspace,
          recentWorkspaces: [],
          toolPermissionMode: "request-approval",
        },
      }),
      validateWorkspace: async () => ({ ok: true }),
      getMissionModelOptions: async () => ({
        runtime: { id: "runtime" },
        models: [{ id: "model", provider: { id: "provider", kind: "registered" } }],
        status: "ready",
      }),
      subscribeRuntimeModelCatalog: () => () => {},
      createMission,
    },
  });
  return { storage, createMission };
}

function knowledgeSelection(view: ReturnType<typeof renderer>) {
  (
    view.props((props) => props.className === "mission-context-store-trigger").onClick as () => void
  )();
}

it("keeps project knowledge in memory and in the cleared draft, then restores it on returning Home", async () => {
  const { storage, createMission } = fixture();
  let draftAtNavigation: ReturnType<typeof readHomeDraft>;
  const onCreated = vi.fn(() => {
    // Navigation may unmount Home before the persistence effect gets another render.
    draftAtNavigation = readHomeDraft(storage);
  });
  const view = renderer(() => HomePage({ onCreated }));
  try {
    await view.flush();
    const projects = view.props((_props, type) => type === HomeProjects);
    expect(projects.disabled).toBe(false);
    (projects.onSelect as (value: HomeProject) => void)(project);
    await view.flush();
    const goal = view.props((props) => props.id === "mission-goal");
    (goal.onChange as (event: unknown) => void)({ target: { value: "Review this project" } });
    await view.flush();
    const submit = view.props((props) => props.className === "mission-submit-button");
    expect(submit.disabled).toBe(false);
    (submit.onClick as () => void)();
    await view.flush();
    expect(createMission).toHaveBeenCalledWith(
      expect.objectContaining({
        executor: { ref: executorRef },
        workspace: workspace.path,
        contextMounts: storeIds.map((storeId) => ({ kind: "context-store", storeId })),
      }),
    );
    expect(onCreated).toHaveBeenCalledOnce();
    expect(draftAtNavigation).toMatchObject({
      executorRef,
      workspaceOverride: workspace,
      contextStoreIds: storeIds,
      goal: "",
    });
    expect(view.props((props) => props.id === "mission-goal").value).toBe("");
    knowledgeSelection(view);
    await view.flush();
    expect(
      view.props((_props, type) => type === ContextStorePickerDialog).selectedStoreIds,
    ).toEqual(storeIds);
    expect(readHomeDraft(storage)?.contextStoreIds).toEqual(storeIds);
  } finally {
    view.unmount();
  }

  hooks.reset();
  const returned = renderer(() => HomePage({ onCreated }));
  try {
    await returned.flush();
    expect(returned.props((_props, type) => type === WorkspacePicker).selection).toEqual(workspace);
    expect(returned.props((props) => props.id === "mission-goal").value).toBe("");
    expect(returned.props((_props, type) => type === HomeProjects).selectedIds).toEqual([
      project.id,
    ]);
    knowledgeSelection(returned);
    await returned.flush();
    expect(
      returned.props((_props, type) => type === ContextStorePickerDialog).selectedStoreIds,
    ).toEqual(storeIds);
  } finally {
    returned.unmount();
  }
});

it("automatically matches projects and clears selection when any binding changes", async () => {
  fixture();
  const view = renderer(() => HomePage({ onCreated: () => undefined }));
  const selection = () => view.props((_props, type) => type === HomeProjects).selectedIds;
  const changeWorkspace = (value: { path: string; basename: string } | undefined) =>
    (view.props((_props, type) => type === WorkspacePicker).onSelect as (value: unknown) => void)(
      value,
    );
  const changeKnowledge = (ids: string[]) =>
    (
      view.props((_props, type) => type === ContextStorePickerDialog).onSelectedStoreIdsChange as (
        ids: string[],
      ) => void
    )(ids);
  const changeExecutor = (ref: string) =>
    (
      view.props((props) => props.onPreferenceChange !== undefined).onChange as (
        ref: string,
      ) => void
    )(ref);
  try {
    await view.flush();
    expect(selection()).toEqual([]);
    knowledgeSelection(view);
    await view.flush();
    // Match without clicking a project; knowledge order does not affect the selection.
    changeKnowledge([...storeIds].reverse());
    await view.flush();
    expect(selection()).toEqual([project.id]);

    changeWorkspace({ path: "/workspace/other", basename: "other" });
    await view.flush();
    expect(selection()).toEqual([]);
    changeWorkspace({ ...workspace, path: `${workspace.path}/` });
    await view.flush();
    expect(selection()).toEqual([project.id]);

    changeKnowledge(storeIds.slice(0, 1));
    await view.flush();
    expect(selection()).toEqual([]);
    changeKnowledge([...storeIds]);
    await view.flush();
    expect(selection()).toEqual([project.id]);

    changeExecutor("expert:0000000000000001");
    await view.flush();
    expect(selection()).toEqual([]);
    changeExecutor(executorRef);
    await view.flush();
    expect(selection()).toEqual([project.id]);

    changeWorkspace(undefined);
    await view.flush();
    expect(selection()).toEqual([project.id]);
  } finally {
    view.unmount();
  }
});

it("selects every matching project even when multiple projects share the same bindings", async () => {
  const duplicate = { ...project, id: "00000000-0000-4000-8000-000000000002", name: "Duplicate" };
  fixture([project, duplicate]);
  const view = renderer(() => HomePage({ onCreated: () => undefined }));
  try {
    await view.flush();
    const projects = view.props((_props, type) => type === HomeProjects);
    (projects.onSelect as (value: HomeProject) => void)(duplicate);
    await view.flush();
    expect(view.props((_props, type) => type === HomeProjects).selectedIds).toEqual([
      project.id,
      duplicate.id,
    ]);
  } finally {
    view.unmount();
  }
});

it("keeps knowledge, input and workspace available for retry when Mission creation fails", async () => {
  const { storage, createMission } = fixture();
  createMission.mockRejectedValueOnce(new Error("Creation failed"));
  const onCreated = vi.fn();
  const view = renderer(() => HomePage({ onCreated }));
  try {
    await view.flush();
    (view.props((_props, type) => type === HomeProjects).onSelect as (value: HomeProject) => void)(
      project,
    );
    await view.flush();
    (view.props((props) => props.id === "mission-goal").onChange as (event: unknown) => void)({
      target: { value: "Retry me" },
    });
    await view.flush();
    (view.props((props) => props.className === "mission-submit-button").onClick as () => void)();
    await view.flush();
    expect(onCreated).not.toHaveBeenCalled();
    expect(view.props((props) => props.className === "mission-submit-button").disabled).toBe(false);
    expect(readHomeDraft(storage)).toMatchObject({
      executorRef,
      workspaceOverride: workspace,
      contextStoreIds: storeIds,
      goal: "Retry me",
    });
    expect(view.props((_props, type) => type === HomeProjects).selectedIds).toEqual([project.id]);
    (view.props((props) => props.className === "mission-submit-button").onClick as () => void)();
    await view.flush();
    expect(onCreated).toHaveBeenCalledOnce();
    expect(createMission).toHaveBeenCalledTimes(2);
    expect(createMission.mock.calls[1]?.[0].contextMounts).toEqual(
      storeIds.map((storeId) => ({ kind: "context-store", storeId })),
    );
  } finally {
    view.unmount();
  }
});

it("uses the workspace passed from a Mission tab ahead of the Home draft and submits it", async () => {
  const { storage, createMission } = fixture([]);
  const selectedWorkspace = { path: "/workspace/from-mission-tab", basename: "from-mission-tab" };
  writeHomeDraft(storage, {
    executorRef,
    workspaceOverride: { path: "/workspace/old-draft", basename: "old-draft" },
    goal: "Retain the existing draft message",
    flowInput: {},
    toolPermissionMode: "request-approval",
  });
  const view = renderer(() =>
    HomePage({ initialWorkspace: selectedWorkspace, onCreated: () => undefined }),
  );
  try {
    await view.flush();
    const picker = () => view.props((_props, type) => type === WorkspacePicker);
    expect(picker().selection).toEqual(selectedWorkspace);
    expect(picker().defaultSelected).toBe(false);
    expect(view.props((props) => props.id === "mission-goal").value).toBe(
      "Retain the existing draft message",
    );
    expect(readHomeDraft(storage)?.workspaceOverride).toEqual(selectedWorkspace);
    (view.props((props) => props.className === "mission-submit-button").onClick as () => void)();
    await view.flush();
    expect(createMission).toHaveBeenCalledWith(
      expect.objectContaining({ workspace: selectedWorkspace.path }),
    );
    const changedWorkspace = { path: "/workspace/user-choice", basename: "user-choice" };
    (picker().onSelect as (value: unknown) => void)(changedWorkspace);
    await view.flush();
    expect(picker().selection).toEqual(changedWorkspace);
  } finally {
    view.unmount();
  }
});

it("recognizes the default workspace after explicit selection and returning Home", async () => {
  const { storage } = fixture([]);
  const restored = { ...workspace, basename: "workspace" };
  const view = renderer(() => HomePage({ onCreated: () => undefined }));
  try {
    await view.flush();
    const picker = view.props((_props, type) => type === WorkspacePicker);
    (picker.onSelect as (value: unknown) => void)(restored);
    await view.flush();
    expect(view.props((_props, type) => type === WorkspacePicker).defaultSelected).toBe(true);
    expect(readHomeDraft(storage)?.workspaceOverride).toEqual(restored);
  } finally {
    view.unmount();
  }
  hooks.reset();
  const returned = renderer(() => HomePage({ onCreated: () => undefined }));
  try {
    await returned.flush();
    const picker = returned.props((_props, type) => type === WorkspacePicker);
    expect(picker.selection).toEqual(restored);
    expect(picker.defaultSelected).toBe(true);
  } finally {
    returned.unmount();
  }
});

it.each([null, { path: "/workspace/from-tab", basename: "from-tab" }])(
  "passes only an explicitly selected workspace tab through the new-Mission action (%j)",
  async (selectedWorkspace) => {
    fixture([]);
    Object.assign(window.pragmaDesktop, {
      subscribeMissionChatUpdates: () => () => undefined,
      subscribeMissionStatusUpdates: () => () => undefined,
      subscribeMissionUpdates: () => () => undefined,
      listMissions: async () => [],
      getMissionCreationDefaults: async () => ({ workspace, recentWorkspaces: [] }),
    });
    const onCreate = vi.fn();
    const view = renderer(() =>
      MissionsPage({
        initialMemoryState: {
          missions: [],
          selectedMission: null,
          selectedMissionId: null,
          workspacePath: selectedWorkspace?.path ?? null,
          workspaceTabs: {
            initialized: true,
            orderPaths: selectedWorkspace === null ? [] : [selectedWorkspace.path],
            closedPaths: [],
            addedWorkspaces: selectedWorkspace === null ? [] : [selectedWorkspace],
          },
        },
        onCreate,
      }),
    );
    try {
      await view.flush();
      expect(view.props((_props, type) => type === MissionWorkspaceTabs).defaultWorkspacePath).toBe(
        workspace.path,
      );
      (view.props((_props, type) => type === MissionRail).onCreate as () => void)();
      expect(onCreate).toHaveBeenCalledExactlyOnceWith(selectedWorkspace ?? undefined);
    } finally {
      view.unmount();
    }
  },
);

it("preserves intervening tab changes while the folder picker is pending", async () => {
  const a = { path: "/a", basename: "a" };
  const b = { path: "/b", basename: "b" };
  const picked = { path: "/picked", basename: "picked" };
  let state = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, []);
  state = addMissionWorkspaceTab(addMissionWorkspaceTab(state, a), b);
  let resolvePick!: (workspace: typeof picked) => void;
  const picker = new Promise<typeof picked>((resolve) => {
    resolvePick = resolve;
  });
  const view = renderer(() =>
    MissionWorkspaceTabs({
      missions: [],
      state,
      value: null,
      onChange: () => {},
      onStateChange: (update) => {
        state = typeof update === "function" ? update(state) : update;
      },
      onPickWorkspace: () => picker,
    }),
  );
  try {
    (
      view.props((props) => props.ariaLabel === "addWorkspaceTab").onChange as (
        path: string,
      ) => void
    )("pick-workspace");
    // The picker can stay open while task events or another window update the tabs.
    state = addMissionWorkspaceTab(closeMissionWorkspaceTab(state, a.path), {
      path: "/new",
      basename: "new",
    });
    resolvePick(picked);
    await view.flush();
    expect(state.orderPaths).toEqual(["/picked", "/new", "/b"]);
    expect(state.closedPaths).toEqual(["/a"]);
  } finally {
    view.unmount();
  }
});

it("opens a submitted Mission workspace immediately and saves tab edits even when list refresh fails", async () => {
  const { storage } = fixture([]);
  const old = { path: "/old", basename: "old" };
  const saved = addMissionWorkspaceTab(
    reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, []),
    old,
  );
  expect(writeMissionWorkspaceTabs(storage, saved)).toBe(true);
  const created = MissionSchema.parse({
    schemaVersion: "pragma.mission/v11",
    origin: { type: "user" },
    id: "00000000-0000-4000-8000-000000000001",
    title: "New task",
    goal: "Test workspace tabs",
    initialMessageId: "00000000-0000-4000-8000-000000000002",
    toolPermissionMode: "request-approval",
    workspace,
    project: { id: "studio", revision: 1 },
    contextMounts: [],
    executor: { kind: "expert", name: "Pragma", ref: executorRef },
    lifecycleStatus: "active",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
  });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  Object.assign(window.pragmaDesktop, {
    runMission: async () => created,
    reportRendererLog: () => {},
    getMission: async () => created,
    getMissionChatPage: async () => {
      throw new Error("offline");
    },
    listMissions: async () => {
      throw new Error("offline");
    },
    getMissionCreationDefaults: async () => ({ workspace, recentWorkspaces: [] }),
    subscribeMissionChatUpdates: () => () => {},
    subscribeMissionStatusUpdates: () => () => {},
    subscribeMissionUpdates: () => () => {},
  });
  const view = renderer(() =>
    MissionsPage({
      initialMission: created,
      autoRunInitialMission: true,
      onCreate: () => {},
      initialMemoryState: {
        missions: [],
        selectedMission: null,
        selectedMissionId: null,
        workspacePath: workspace.path,
      },
    }),
  );
  try {
    const tabs = () => view.props((_props, type) => type === MissionWorkspaceTabs);
    expect((tabs().state as MissionWorkspaceTabState).orderPaths).toEqual([
      workspace.path,
      old.path,
    ]);
    await view.flush();
    (
      tabs().onStateChange as (
        update: (current: MissionWorkspaceTabState) => MissionWorkspaceTabState,
      ) => void
    )((current) => closeMissionWorkspaceTab(current, old.path));
    await view.flush();
    expect(readMissionWorkspaceTabs(storage)).toMatchObject({
      status: "ready",
      state: {
        orderPaths: [workspace.path],
        closedPaths: [old.path],
      },
    });
  } finally {
    view.unmount();
  }
});

it("captures tab drags immediately and ignores mouse movement after release outside the tab", () => {
  const tab = { path: "/drag", basename: "drag" };
  const state = addMissionWorkspaceTab(
    reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, []),
    tab,
  );
  const onStateChange = vi.fn();
  const view = renderer(() =>
    MissionWorkspaceTabs({
      missions: [],
      state,
      value: null,
      onChange: () => {},
      onStateChange,
    }),
  );
  try {
    const scroller = view.props((props) => props.className === "mission-workspace-scroll");
    const setPointerCapture = vi.fn();
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("getComputedStyle", () => ({ width: "128px" }));
    const releasePointerCapture = vi.fn();
    const capture = { setPointerCapture, hasPointerCapture: () => true, releasePointerCapture };
    const bounds = { left: 0, width: 128 };
    const slot = {
      dataset: { workspacePath: tab.path },
      querySelector: () => capture,
      getBoundingClientRect: () => bounds,
    };
    const event = {
      button: 0,
      pointerType: "mouse",
      pointerId: 1,
      clientX: 10,
      clientY: 10,
      target: {
        closest: (selector: string) => (selector === ".mission-workspace-tab-slot" ? slot : null),
      },
      currentTarget: {
        getBoundingClientRect: () => bounds,
        querySelectorAll: () => [slot],
        scrollLeft: 0,
      },
    };
    (scroller.onPointerDown as (event: unknown) => void)(event);
    expect(setPointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    for (const handler of ["onPointerCancel", "onLostPointerCapture"]) {
      (scroller[handler] as (event: unknown) => void)({ pointerId: 2 });
      expect(releasePointerCapture).not.toHaveBeenCalled();
    }
    (scroller.onPointerMove as (event: unknown) => void)({ ...event, buttons: 0, clientX: 100 });
    (scroller.onPointerUp as (event: unknown) => void)(event);
    expect(releasePointerCapture).toHaveBeenCalledExactlyOnceWith(1);
    const preventDefault = vi.fn();
    (scroller.onClickCapture as (event: unknown) => void)({
      preventDefault,
      stopPropagation: vi.fn(),
    });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(onStateChange).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("uses the latest workspace selection callback when a delayed picker resolves", async () => {
  const picked = { path: "/picked", basename: "picked" };
  const first = vi.fn();
  const latest = vi.fn();
  let resolvePick!: (value: typeof picked) => void;
  const picker = new Promise<typeof picked>((resolve) => {
    resolvePick = resolve;
  });
  let rerender!: () => void;
  let onChange = first;
  const view = renderer(() => {
    const [, setRevision] = hooks.useState(0);
    rerender = () => setRevision((current) => current + 1);
    return MissionWorkspaceTabs({
      missions: [],
      value: null,
      state: reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, []),
      onStateChange: () => {},
      onChange,
      onPickWorkspace: () => picker,
    });
  });
  try {
    (
      view.props((props) => props.ariaLabel === "addWorkspaceTab").onChange as (
        path: string,
      ) => void
    )("pick-workspace");
    onChange = latest;
    rerender();
    await view.flush();
    resolvePick(picked);
    await view.flush();
    expect(latest).toHaveBeenCalledExactlyOnceWith(picked.path);
    expect(first).not.toHaveBeenCalled();
  } finally {
    view.unmount();
  }
});

it("reorders the visible tabs before the initial mission list refresh finishes", () => {
  let state = EMPTY_MISSION_WORKSPACE_TABS;
  const missions = ["/a", "/b"].map((path) => ({
    id: path,
    title: path,
    workspace: { path, basename: path },
    executor: { kind: "expert" as const, name: "Pragma" },
    source: { type: "task" as const },
    lifecycleStatus: "active" as const,
    updatedAt: "2026-10-22T00:00:00.000Z",
  }));
  const view = renderer(() =>
    MissionWorkspaceTabs({
      missions,
      state,
      value: "/a",
      onChange: () => {},
      onStateChange: (update) => {
        state = typeof update === "function" ? update(state) : update;
      },
    }),
  );
  try {
    const target = {};
    (view.props((props) => props.role === "tablist").onKeyDown as (event: unknown) => void)({
      target,
      currentTarget: { querySelectorAll: () => [{}, target, {}] },
      altKey: true,
      shiftKey: true,
      key: "ArrowRight",
      preventDefault: () => {},
    });
    expect(state.orderPaths).toEqual(["/b", "/a"]);
  } finally {
    view.unmount();
  }
});

it("does not scroll backward when a frame timestamp precedes the last pointer event", () => {
  const state = reconcileMissionWorkspaceTabs(EMPTY_MISSION_WORKSPACE_TABS, []);
  const workspaces = ["/a", "/b"].map((path) => ({ path, basename: path }));
  const callbacks: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    callbacks.push(callback);
    return callbacks.length;
  });
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("getComputedStyle", () => ({ width: "128px" }));
  const now = vi.spyOn(performance, "now").mockReturnValue(100);
  const capture = { setPointerCapture: vi.fn(), hasPointerCapture: () => false };
  const slots = workspaces.map((workspace, index) => ({
    dataset: { workspacePath: workspace.path },
    querySelector: () => capture,
    getBoundingClientRect: () => ({ left: index * 128 - 64, width: 128 }),
    style: { transform: "" },
  }));
  const container = {
    getBoundingClientRect: () => ({ left: 0, right: 128, width: 128 }),
    querySelectorAll: () => slots,
    scrollLeft: 64,
  };
  const view = renderer(() =>
    MissionWorkspaceTabs({
      missions: [],
      state: workspaces.reduce(addMissionWorkspaceTab, state),
      value: null,
      onChange: () => {},
      onStateChange: () => {},
    }),
  );
  try {
    const scroller = view.props((props) => props.className === "mission-workspace-scroll");
    const event = {
      button: 0,
      pointerType: "mouse",
      pointerId: 1,
      clientX: 20,
      clientY: 10,
      target: {
        closest: (selector: string) =>
          selector === ".mission-workspace-tab-slot" ? slots[0] : null,
      },
      currentTarget: container,
    };
    (scroller.onPointerDown as (event: unknown) => void)(event);
    (scroller.onPointerMove as (event: unknown) => void)({
      ...event,
      buttons: 1,
      clientX: 127,
      preventDefault: () => {},
    });
    callbacks.shift()!(90);
    expect(container.scrollLeft).toBeGreaterThanOrEqual(64);
    callbacks.shift()!(120);
    expect(container.scrollLeft).toBeGreaterThan(64);
  } finally {
    view.unmount();
    now.mockRestore();
  }
});
