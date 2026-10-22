import { isValidElement, type ReactNode } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { HomeProject } from "../../../../shared/contracts/index.ts";
import { readHomeDraft } from "../../lib/home-draft.ts";
import { ContextStorePickerDialog } from "../../components/ContextStorePickerDialog.tsx";
import { WorkspacePicker } from "../../components/WorkspacePicker.tsx";
import { HomeProjects } from "./HomeProjects.tsx";
import { HomePage } from "./HomePage.tsx";

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
  useState: hooks.useState,
  useRef: hooks.useRef,
  useCallback: hooks.useCallback,
  useMemo: (factory: () => unknown) => factory(),
  useEffect: hooks.useEffect,
  useLayoutEffect: hooks.useEffect,
}));
vi.mock("react-i18next", () => {
  const t = (key: string) => key;
  return { useTranslation: () => ({ t }) };
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
