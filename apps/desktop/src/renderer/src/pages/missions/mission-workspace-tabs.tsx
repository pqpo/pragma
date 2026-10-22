import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Dispatch,
  type SetStateAction,
} from "react";
import { Folder, FolderOpen, Plus, SquaresFour, X } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";
import type {
  MissionSummary,
  MissionCreationDefaults,
} from "../../../../shared/contracts/index.ts";
import { SelectMenu } from "../../components/SelectMenu.tsx";

type Workspace = MissionCreationDefaults["workspace"];
export {
  EMPTY_MISSION_WORKSPACE_TABS,
  visibleMissionWorkspaces,
  addMissionWorkspaceTab,
  closeMissionWorkspaceTab,
} from "../../lib/mission-workspace-tabs-preference.ts";
export type { MissionWorkspaceTabState } from "../../lib/mission-workspace-tabs-preference.ts";
import {
  visibleMissionWorkspaces,
  addMissionWorkspaceTab,
  closeMissionWorkspaceTab,
  reconcileMissionWorkspaceTabs,
  moveMissionWorkspaceTab,
  type MissionWorkspaceTabState,
} from "../../lib/mission-workspace-tabs-preference.ts";

function sortedWorkspaces(workspaces: readonly Workspace[], language: string): Workspace[] {
  const unique = new Map(workspaces.map((workspace) => [workspace.path, workspace]));
  const collator = new Intl.Collator(language, { numeric: true, sensitivity: "base" });
  return [...unique.values()].sort(
    (left, right) =>
      collator.compare(left.basename, right.basename) || collator.compare(left.path, right.path),
  );
}

export function missionWorkspaces(missions: readonly MissionSummary[], language: string) {
  return sortedWorkspaces(
    missions.flatMap(({ workspace }) =>
      workspace.path === undefined ? [] : [{ ...workspace, path: workspace.path }],
    ),
    language,
  );
}

export function missionMatchesWorkspace(mission: MissionSummary, path: string | null): boolean {
  return path === null || mission.workspace.path === path;
}

const PICK_WORKSPACE = "pick-workspace";

export function MissionWorkspaceTabs(props: {
  readonly missions: readonly MissionSummary[];
  readonly value: string | null;
  readonly onChange: (path: string | null) => void;
  readonly state: MissionWorkspaceTabState;
  readonly onStateChange: Dispatch<SetStateAction<MissionWorkspaceTabState>>;
  readonly knownWorkspaces?: readonly Workspace[] | undefined;
  readonly onPickWorkspace?: (() => Promise<Workspace | undefined>) | undefined;
}) {
  const { t, i18n } = useTranslation("missions");
  const id = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const latestPropsRef = useRef(props);
  latestPropsRef.current = props;
  const state = props.state;
  const dragRef = useRef<{
    path: string;
    startX: number;
    startY: number;
    moved: boolean;
    target?: string;
    placement?: "before" | "after";
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const workspaces = useMemo(
    () => visibleMissionWorkspaces(props.missions, state),
    [props.missions, state],
  );
  const candidates = sortedWorkspaces(
    [
      ...missionWorkspaces(props.missions, i18n.language),
      ...(props.knownWorkspaces ?? []),
      ...state.addedWorkspaces,
    ],
    i18n.language,
  ).filter((workspace) => !workspaces.some((open) => open.path === workspace.path));
  const allLabel = t("allWorkspaces");
  const options = [
    ...candidates.map((workspace) => ({
      value: workspace.path,
      label: workspace.basename,
      description: workspace.path,
      icon: <Folder size={18} />,
    })),
    { value: PICK_WORKSPACE, label: t("chooseDifferentWorkspace"), icon: <FolderOpen size={18} /> },
  ];

  useEffect(() => {
    rootRef.current
      ?.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      ?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [props.value, i18n.language]);

  useEffect(() => {
    if (props.value !== null && !workspaces.some((workspace) => workspace.path === props.value)) {
      props.onChange(null);
    }
  }, [props.value, props.onChange, workspaces]);

  const addWorkspace = (workspace: Workspace) => {
    const latestProps = latestPropsRef.current;
    latestProps.onStateChange((current) =>
      addMissionWorkspaceTab(
        current.initialized
          ? current
          : reconcileMissionWorkspaceTabs(current, latestProps.missions),
        workspace,
      ),
    );
    latestProps.onChange(workspace.path);
  };
  const closeWorkspace = (path: string) => {
    props.onStateChange((current) =>
      closeMissionWorkspaceTab(
        current.initialized ? current : reconcileMissionWorkspaceTabs(current, props.missions),
        path,
      ),
    );
    if (props.value === path) props.onChange(null);
    requestAnimationFrame(() =>
      rootRef.current
        ?.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]')
        ?.focus(),
    );
  };
  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const tabs = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
    const index = tabs.indexOf(event.target as HTMLButtonElement);
    if (index < 0) return;
    if (
      event.altKey &&
      event.shiftKey &&
      index > 0 &&
      ["ArrowLeft", "ArrowRight"].includes(event.key)
    ) {
      event.preventDefault();
      const direction = event.key === "ArrowLeft" ? -1 : 1;
      const target = workspaces[index - 1 + direction];
      if (target !== undefined)
        props.onStateChange((current) =>
          moveMissionWorkspaceTab(
            current.initialized ? current : reconcileMissionWorkspaceTabs(current, props.missions),
            workspaces[index - 1]!.path,
            target.path,
            direction < 0 ? "before" : "after",
          ),
        );
      return;
    }
    if (event.key === "Delete" && index > 0) {
      event.preventDefault();
      closeWorkspace(workspaces[index - 1]!.path);
      return;
    }
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? tabs.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next]?.focus();
    props.onChange(next === 0 ? null : workspaces[next - 1]!.path);
  };

  return (
    <div className="mission-workspace-bar">
      <div
        className="mission-workspace-tabs"
        role="tablist"
        aria-label={t("workspaceCategories")}
        onKeyDown={handleKeyDown}
        ref={rootRef}
      >
        <button
          className={`mission-workspace-all${props.value === null ? " is-active" : ""}`}
          type="button"
          role="tab"
          aria-selected={props.value === null}
          aria-label={allLabel}
          title={allLabel}
          tabIndex={props.value === null ? 0 : -1}
          onClick={() => props.onChange(null)}
        >
          <SquaresFour size={20} aria-hidden="true" />
        </button>
        <div className="mission-workspace-scroll">
          {workspaces.map((workspace, index) => (
            <div
              key={workspace.path}
              className={`mission-workspace-tab-slot${props.value === workspace.path ? " is-active" : ""}${dropTarget === workspace.path ? " is-drop-target" : ""}`}
              data-workspace-path={workspace.path}
              onPointerDown={(event) => {
                suppressClickRef.current = false;
                if (
                  event.button !== 0 ||
                  event.pointerType !== "mouse" ||
                  (event.target as HTMLElement).closest(".mission-workspace-close")
                )
                  return;
                event.currentTarget
                  .querySelector<HTMLButtonElement>(".mission-workspace-tab")
                  ?.setPointerCapture(event.pointerId);
                dragRef.current = {
                  path: workspace.path,
                  startX: event.clientX,
                  startY: event.clientY,
                  moved: false,
                };
              }}
              onPointerMove={(event) => {
                const drag = dragRef.current;
                if (drag === null) return;
                if (event.buttons !== 1) {
                  dragRef.current = null;
                  setDropTarget(null);
                  return;
                }
                if (
                  !drag.moved &&
                  Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5
                )
                  return;
                drag.moved = true;
                const slots = rootRef.current?.querySelectorAll<HTMLElement>(
                  ".mission-workspace-tab-slot",
                );
                const target = [...(slots ?? [])].find((slot) => {
                  const rect = slot.getBoundingClientRect();
                  return (
                    event.clientX >= rect.left &&
                    event.clientX <= rect.right &&
                    event.clientY >= rect.top &&
                    event.clientY <= rect.bottom
                  );
                });
                const targetPath = target?.dataset.workspacePath;
                if (target === undefined || targetPath === undefined || targetPath === drag.path) {
                  delete drag.target;
                  delete drag.placement;
                  setDropTarget(null);
                  return;
                }
                const rect = target.getBoundingClientRect();
                drag.target = targetPath;
                drag.placement = event.clientX < rect.left + rect.width / 2 ? "before" : "after";
                setDropTarget(targetPath ?? null);
              }}
              onPointerUp={(event) => {
                const drag = dragRef.current;
                if (drag === null) return;
                suppressClickRef.current = drag.moved;
                if (drag.target !== undefined && drag.placement !== undefined) {
                  const target = drag.target;
                  const placement = drag.placement;
                  props.onStateChange((current) =>
                    moveMissionWorkspaceTab(
                      current.initialized
                        ? current
                        : reconcileMissionWorkspaceTabs(current, props.missions),
                      drag.path,
                      target,
                      placement,
                    ),
                  );
                }
                const button =
                  event.currentTarget.querySelector<HTMLButtonElement>(".mission-workspace-tab");
                if (button?.hasPointerCapture(event.pointerId))
                  button.releasePointerCapture(event.pointerId);
                dragRef.current = null;
                setDropTarget(null);
              }}
              onPointerCancel={() => {
                dragRef.current = null;
                setDropTarget(null);
              }}
              onLostPointerCapture={() => {
                dragRef.current = null;
                setDropTarget(null);
              }}
              onClickCapture={(event) => {
                if (!suppressClickRef.current) return;
                event.preventDefault();
                event.stopPropagation();
                suppressClickRef.current = false;
              }}
            >
              <button
                id={`${id}-${index}`}
                type="button"
                role="tab"
                aria-selected={props.value === workspace.path}
                tabIndex={props.value === workspace.path ? 0 : -1}
                className={`mission-workspace-tab${props.value === workspace.path ? " is-active" : ""}`}
                title={`${workspace.basename}\n${workspace.path}\n${t("dragWorkspaceTab")}`}
                onClick={() => props.onChange(workspace.path)}
              >
                <Folder size={18} aria-hidden="true" />
                <span>{workspace.basename}</span>
              </button>
              <button
                className="mission-workspace-close"
                type="button"
                aria-label={t("closeWorkspaceTab", { name: workspace.basename })}
                title={t("closeWorkspaceTab", { name: workspace.basename })}
                tabIndex={props.value === workspace.path ? 0 : -1}
                onClick={() => closeWorkspace(workspace.path)}
              >
                <X size={14} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      </div>
      <SelectMenu
        ariaLabel={t("addWorkspaceTab")}
        title={t("addWorkspaceTab")}
        className="mission-workspace-overflow"
        menuClassName="mission-workspace-overflow-menu"
        menuMinWidth={420}
        animateOverflowingOptions
        options={options}
        value=""
        onChange={(path) => {
          if (path === PICK_WORKSPACE) {
            void props.onPickWorkspace?.().then((workspace) => {
              if (workspace !== undefined) addWorkspace(workspace);
            });
          } else {
            const workspace = candidates.find((item) => item.path === path);
            if (workspace !== undefined) addWorkspace(workspace);
          }
        }}
        indicator={<Plus size={18} aria-hidden="true" />}
        searchable
        searchPlaceholder={t("searchWorkspaces")}
        emptyLabel={t("workspaceSearchEmpty")}
        align="end"
      />
    </div>
  );
}
