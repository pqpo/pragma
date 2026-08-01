import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";

import { clampSidebarWidth, type SidebarWidthPreference } from "../lib/sidebar-width-preference.ts";

const keyboardResizeStep = 8;
const largeKeyboardResizeStep = 24;

export function SidebarResizeHandle(props: {
  readonly label: string;
  readonly width: number;
  readonly preference: SidebarWidthPreference;
  readonly onResize: (width: number) => void;
}) {
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{
    readonly pointerId: number;
    readonly startX: number;
    readonly width: number;
  } | null>(null);

  useEffect(
    () => () => {
      if (dragRef.current !== null) {
        document.documentElement.classList.remove("is-resizing-sidebar");
      }
    },
    [],
  );

  const stopDragging = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setDragging(false);
    event.currentTarget.ownerDocument.documentElement.classList.remove("is-resizing-sidebar");
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? largeKeyboardResizeStep : keyboardResizeStep;
    let nextWidth: number | undefined;
    if (event.key === "ArrowLeft") nextWidth = props.width - step;
    if (event.key === "ArrowRight") nextWidth = props.width + step;
    if (event.key === "Home") nextWidth = props.preference.minWidth;
    if (event.key === "End") nextWidth = props.preference.maxWidth;
    if (nextWidth === undefined) return;
    event.preventDefault();
    props.onResize(clampSidebarWidth(nextWidth, props.preference));
  };

  return (
    <div
      className={dragging ? "sidebar-resize-handle is-dragging" : "sidebar-resize-handle"}
      role="separator"
      aria-label={props.label}
      aria-orientation="vertical"
      aria-valuemin={props.preference.minWidth}
      aria-valuemax={props.preference.maxWidth}
      aria-valuenow={props.width}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.preventDefault();
        dragRef.current = {
          pointerId: event.pointerId,
          startX: event.clientX,
          width: props.width,
        };
        event.currentTarget.setPointerCapture(event.pointerId);
        event.currentTarget.ownerDocument.documentElement.classList.add("is-resizing-sidebar");
        setDragging(true);
      }}
      onPointerMove={(event) => {
        const drag = dragRef.current;
        if (drag?.pointerId !== event.pointerId) return;
        props.onResize(
          clampSidebarWidth(drag.width + event.clientX - drag.startX, props.preference),
        );
      }}
      onPointerUp={stopDragging}
      onPointerCancel={stopDragging}
      onLostPointerCapture={() => {
        dragRef.current = null;
        setDragging(false);
        document.documentElement.classList.remove("is-resizing-sidebar");
      }}
    />
  );
}
