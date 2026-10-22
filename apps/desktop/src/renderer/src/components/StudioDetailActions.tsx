import { DotsThree } from "@phosphor-icons/react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { StudioActionButton } from "./StudioActionButton.tsx";

export function StudioDetailActions(props: {
  readonly primary: ReactNode;
  readonly children: ReactNode;
}) {
  const { t } = useTranslation("common");
  const [expanded, setExpanded] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pointerInside = useRef(false);
  const actionsId = useId();
  const cancelClose = () => {
    if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    closeTimer.current = null;
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => {
      closeTimer.current = null;
      if (!pointerInside.current && !groupRef.current?.contains(document.activeElement)) {
        setExpanded(false);
      }
    }, 500);
  };
  useEffect(() => () => cancelClose(), []);

  return (
    <div
      ref={groupRef}
      className={`studio-detail-actions${expanded ? " is-expanded" : ""}`}
      onMouseEnter={() => {
        pointerInside.current = true;
        cancelClose();
      }}
      onMouseLeave={() => {
        pointerInside.current = false;
        scheduleClose();
      }}
      onFocusCapture={cancelClose}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) scheduleClose();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && expanded) {
          event.stopPropagation();
          groupRef.current?.querySelector<HTMLButtonElement>("[aria-controls]")?.focus();
          setExpanded(false);
        }
      }}
    >
      {props.primary}
      <div className="studio-detail-actions-reveal" id={actionsId} inert={!expanded}>
        <div className="studio-detail-actions-overflow">{props.children}</div>
      </div>
      <span
        className="studio-detail-more"
        onMouseEnter={() => {
          cancelClose();
          setExpanded(true);
        }}
      >
        <StudioActionButton
          label={t("navigation.more")}
          icon={<DotsThree size={18} aria-hidden="true" />}
          expanded={expanded}
          controls={actionsId}
          onClick={() => {
            cancelClose();
            setExpanded(true);
          }}
        />
      </span>
    </div>
  );
}
