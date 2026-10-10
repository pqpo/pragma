import { useId } from "react";
import { Folder } from "@phosphor-icons/react";
import { useTranslation } from "react-i18next";

export function MissionWorkspaceStatus(props: {
  name: string;
  available: boolean | null | undefined;
}) {
  const { t } = useTranslation("missions");
  const tooltipId = useId();
  const unavailable = props.available === false;
  return (
    <span
      className={`mission-workspace-status${unavailable ? " is-unavailable" : ""}`}
      tabIndex={unavailable ? 0 : undefined}
      aria-describedby={unavailable ? tooltipId : undefined}
    >
      <span className="mission-workspace-folder" aria-hidden="true">
        <Folder size={16} />
      </span>
      {props.name}
      {unavailable ? (
        <span
          id={tooltipId}
          className="studio-action-tooltip mission-workspace-tooltip"
          role="tooltip"
        >
          {t("workspaceUnavailableTitle")}
        </span>
      ) : null}
    </span>
  );
}
