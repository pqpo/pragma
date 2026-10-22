import { z } from "zod";
import { MissionWorkspaceSchema, type MissionSummary } from "../../../shared/contracts/index.ts";

type Workspace = z.infer<typeof MissionWorkspaceSchema>;
const StateSchema = z
  .object({
    initialized: z.boolean(),
    closedPaths: z.array(MissionWorkspaceSchema.shape.path).readonly(),
    addedWorkspaces: z.array(MissionWorkspaceSchema).readonly(),
    orderPaths: z.array(MissionWorkspaceSchema.shape.path).readonly(),
  })
  .strict();
export type MissionWorkspaceTabState = Readonly<z.infer<typeof StateSchema>>;
const PreferenceSchema = StateSchema.extend({
  schemaVersion: z.literal("pragma.desktop.workspace-tabs/v1"),
  initialized: z.literal(true),
}).refine((state) => {
  const known = new Set(state.addedWorkspaces.map((workspace) => workspace.path));
  const closed = new Set(state.closedPaths);
  return (
    known.size === state.addedWorkspaces.length &&
    closed.size === state.closedPaths.length &&
    new Set(state.orderPaths).size === state.orderPaths.length &&
    state.orderPaths.every((path) => known.has(path) && !closed.has(path))
  );
});
const storageKey = "pragma.desktop.missions.workspace-tabs.v1";
export const EMPTY_MISSION_WORKSPACE_TABS: MissionWorkspaceTabState = {
  initialized: false,
  closedPaths: [],
  addedWorkspaces: [],
  orderPaths: [],
};

type Reader = Pick<Storage, "getItem">;
type Writer = Reader & Pick<Storage, "setItem">;
export function readMissionWorkspaceTabs(
  storage: Reader | undefined,
):
  | { readonly status: "missing" }
  | { readonly status: "ready"; readonly state: MissionWorkspaceTabState }
  | { readonly status: "invalid" | "unavailable" } {
  let raw: string | null | undefined;
  try {
    raw = storage?.getItem(storageKey);
  } catch {
    return { status: "unavailable" };
  }
  if (raw == null) return { status: "missing" };
  try {
    const parsed = PreferenceSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { status: "invalid" };
    return {
      status: "ready",
      state: StateSchema.parse({
        initialized: parsed.data.initialized,
        closedPaths: parsed.data.closedPaths,
        addedWorkspaces: parsed.data.addedWorkspaces,
        orderPaths: parsed.data.orderPaths,
      }),
    };
  } catch {
    return { status: "invalid" };
  }
}

/** A single localStorage replacement is atomic; never replace corrupt or future preferences. */
export function writeMissionWorkspaceTabs(
  storage: Writer | undefined,
  state: MissionWorkspaceTabState,
): boolean {
  if (!state.initialized || storage === undefined) return false;
  const current = readMissionWorkspaceTabs(storage);
  if (current.status === "invalid" || current.status === "unavailable") return false;
  const record = PreferenceSchema.safeParse({
    ...state,
    schemaVersion: "pragma.desktop.workspace-tabs/v1",
  });
  if (!record.success) return false;
  try {
    storage.setItem(storageKey, JSON.stringify(record.data));
    return true;
  } catch {
    return false;
  }
}

function activeWorkspaces(missions: readonly MissionSummary[]): Workspace[] {
  const unique = new Map<string, Workspace>();
  for (const mission of [...missions]
    .filter((item) => item.lifecycleStatus !== "completed")
    .sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id),
    )) {
    const { workspace } = mission;
    if (workspace.path !== undefined && !unique.has(workspace.path)) {
      unique.set(workspace.path, { ...workspace, path: workspace.path });
    }
  }
  return [...unique.values()];
}

export function reconcileMissionWorkspaceTabs(
  state: MissionWorkspaceTabState,
  missions: readonly MissionSummary[],
): MissionWorkspaceTabState {
  const active = activeWorkspaces(missions);
  const known = new Map(state.addedWorkspaces.map((workspace) => [workspace.path, workspace]));
  const open = new Set(state.orderPaths);
  const newPaths = active
    .filter((workspace) => !open.has(workspace.path))
    .map((workspace) => workspace.path);
  for (const { workspace } of missions) {
    if (workspace.path !== undefined)
      known.set(workspace.path, { ...workspace, path: workspace.path });
  }
  const orderPaths = [
    ...new Set(
      state.initialized
        ? [...newPaths, ...state.orderPaths]
        : [...state.orderPaths, ...active.map((workspace) => workspace.path)],
    ),
  ].filter((path) => !state.closedPaths.includes(path));
  const next = { ...state, initialized: true, orderPaths, addedWorkspaces: [...known.values()] };
  return JSON.stringify(next) === JSON.stringify(state) ? state : next;
}

export function visibleMissionWorkspaces(
  missions: readonly MissionSummary[],
  state: MissionWorkspaceTabState,
): Workspace[] {
  const current = state.initialized ? state : reconcileMissionWorkspaceTabs(state, missions);
  const known = new Map(current.addedWorkspaces.map((workspace) => [workspace.path, workspace]));
  return current.orderPaths.flatMap((path) => {
    const workspace = known.get(path);
    return workspace === undefined || current.closedPaths.includes(path) ? [] : [workspace];
  });
}

export function addMissionWorkspaceTab(
  state: MissionWorkspaceTabState,
  workspace: Workspace,
): MissionWorkspaceTabState {
  return {
    ...state,
    closedPaths: state.closedPaths.filter((path) => path !== workspace.path),
    addedWorkspaces: [
      ...state.addedWorkspaces.filter((item) => item.path !== workspace.path),
      workspace,
    ],
    orderPaths: state.orderPaths.includes(workspace.path)
      ? state.orderPaths
      : [workspace.path, ...state.orderPaths],
  };
}

export function closeMissionWorkspaceTab(
  state: MissionWorkspaceTabState,
  path: string,
): MissionWorkspaceTabState {
  return {
    ...state,
    closedPaths: [...new Set([...state.closedPaths, path])],
    orderPaths: state.orderPaths.filter((item) => item !== path),
  };
}

export function moveMissionWorkspaceTab(
  state: MissionWorkspaceTabState,
  path: string,
  target: string,
  placement: "before" | "after",
): MissionWorkspaceTabState {
  if (path === target || !state.orderPaths.includes(path) || !state.orderPaths.includes(target))
    return state;
  const orderPaths = state.orderPaths.filter((item) => item !== path);
  orderPaths.splice(orderPaths.indexOf(target) + (placement === "after" ? 1 : 0), 0, path);
  return { ...state, orderPaths };
}
