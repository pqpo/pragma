import { CaretDown, Check, ClockCounterClockwise, Folder, FolderOpen } from "@phosphor-icons/react";
import { useEffect, useRef, useState, type RefObject } from "react";
import { useTranslation } from "react-i18next";

import type { MissionCreationDefaults } from "../../../shared/contracts/index.ts";

export type WorkspaceSelection = MissionCreationDefaults["workspace"];

export function WorkspacePicker(props: {
  readonly className?: string | undefined;
  readonly defaultWorkspace?: WorkspaceSelection | undefined;
  readonly recentWorkspaces: readonly WorkspaceSelection[];
  readonly selection?: WorkspaceSelection | undefined;
  readonly defaultSelected: boolean;
  readonly onChoose: () => void;
  readonly onSelect: (workspace: WorkspaceSelection) => void;
  readonly onUseDefault: () => void;
}) {
  const { t } = useTranslation("missions");
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const workspace = props.selection ?? props.defaultWorkspace;
  const className = ["mission-workspace-picker", props.className, open ? "is-open" : undefined]
    .filter((value) => value !== undefined)
    .join(" ");

  useDismissableMenu(open, rootRef, () => setOpen(false));

  return (
    <div className={className} ref={rootRef}>
      <button
        className="mission-workspace-trigger"
        type="button"
        aria-expanded={open}
        aria-haspopup="menu"
        onClick={() => setOpen((current) => !current)}
      >
        <Folder size={20} aria-hidden="true" />
        <span>
          <strong>
            {props.defaultSelected
              ? t("useDefaultWorkspace")
              : workspace?.basename || t("taskWorkspace")}
          </strong>
          <small>{workspace?.path ?? t("loadingWorkspace")}</small>
        </span>
        <CaretDown size={16} aria-hidden="true" />
      </button>
      {open ? (
        <div className="mission-workspace-menu" role="menu" aria-label={t("chooseWorkspace")}>
          <button
            type="button"
            role="menuitemradio"
            aria-checked={props.defaultSelected}
            onClick={() => {
              props.onUseDefault();
              setOpen(false);
            }}
          >
            <Folder size={18} aria-hidden="true" />
            <span>
              <strong>{t("useDefaultWorkspace")}</strong>
              <small>{props.defaultWorkspace?.path ?? t("loadingWorkspace")}</small>
            </span>
            {props.defaultSelected ? <Check size={16} aria-hidden="true" /> : null}
          </button>
          {props.recentWorkspaces.length > 0 ? (
            <span className="mission-workspace-menu-heading" role="presentation">
              {t("recentWorkspaces")}
            </span>
          ) : null}
          {props.recentWorkspaces.map((recentWorkspace) => {
            const selected = !props.defaultSelected && workspace?.path === recentWorkspace.path;
            return (
              <button
                key={recentWorkspace.path}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={recentWorkspace.path}
                onClick={() => {
                  props.onSelect(recentWorkspace);
                  setOpen(false);
                }}
              >
                <ClockCounterClockwise size={18} aria-hidden="true" />
                <span>
                  <strong>{recentWorkspace.basename}</strong>
                  <small>{recentWorkspace.path}</small>
                </span>
                {selected ? <Check size={16} aria-hidden="true" /> : null}
              </button>
            );
          })}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              props.onChoose();
            }}
          >
            <FolderOpen size={18} aria-hidden="true" />
            <span>
              <strong>{t("chooseDifferentWorkspace")}</strong>
              <small>{t("workspaceOverrideDescription")}</small>
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

export function workspaceSelectionFromPath(
  path: string,
  knownWorkspaces: readonly WorkspaceSelection[] = [],
): WorkspaceSelection | undefined {
  if (path === "") return undefined;
  const known = knownWorkspaces.find((workspace) => workspace.path === path);
  if (known !== undefined) return known;
  const basename = path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
  return { path, basename };
}

function useDismissableMenu(
  open: boolean,
  rootRef: RefObject<HTMLElement | null>,
  close: () => void,
): void {
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: MouseEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) close();
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("mousedown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [close, open, rootRef]);
}
