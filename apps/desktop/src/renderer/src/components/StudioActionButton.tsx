import { useId, type ReactNode } from "react";

export type StudioActionButtonTone = "default" | "primary" | "danger";

export function StudioActionButton(props: {
  readonly label: string;
  readonly tooltip?: string | undefined;
  readonly icon: ReactNode;
  readonly tooltipPlacement?: "bottom" | "left" | undefined;
  readonly tone?: StudioActionButtonTone | undefined;
  readonly disabled?: boolean | undefined;
  readonly busy?: boolean | undefined;
  readonly onClick: () => void;
}) {
  const tooltipId = useId();
  const tone = props.tone ?? "default";
  const tooltipPlacement = props.tooltipPlacement ?? "bottom";

  return (
    <span
      className={`studio-action-with-tooltip is-${tone}${props.busy ? " is-busy" : ""}${
        tooltipPlacement === "left" ? " is-tooltip-left" : ""
      }`}
    >
      <button
        className="studio-action-button"
        type="button"
        aria-label={props.label}
        aria-describedby={tooltipId}
        disabled={props.disabled}
        onClick={props.onClick}
      >
        {props.icon}
      </button>
      <span id={tooltipId} className="studio-action-tooltip" role="tooltip">
        {props.tooltip ?? props.label}
      </span>
    </span>
  );
}
