import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

const useSafeLayoutEffect = typeof document === "undefined" ? useEffect : useLayoutEffect;

export function StudioDetailDescription(props: { readonly description: string }) {
  const id = useId();
  const descriptionRef = useRef<HTMLParagraphElement>(null);
  const popoverRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const hoveredRef = useRef(false);
  const [truncated, setTruncated] = useState(false);
  const clearTimer = useCallback(() => {
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
  }, []);
  const hide = useCallback(() => {
    clearTimer();
    popoverRef.current?.hidePopover();
  }, [clearTimer]);
  const show = () => {
    clearTimer();
    const description = descriptionRef.current;
    const popover = popoverRef.current;
    if (description === null || popover === null) return;
    if (description.scrollHeight <= description.clientHeight) return;
    popover.showPopover();
    const anchor = description.getBoundingClientRect();
    const bounds = popover.getBoundingClientRect();
    popover.style.left = `${Math.max(24, Math.min(anchor.left, window.innerWidth - bounds.width - 24))}px`;
    popover.style.top = `${Math.max(24, Math.min(anchor.bottom + 8, window.innerHeight - bounds.height - 24))}px`;
  };
  const scheduleHide = () => {
    clearTimer();
    if (!popoverRef.current?.matches(":popover-open")) return;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      const description = descriptionRef.current;
      if (document.activeElement === description) return;
      if (hoveredRef.current) return;
      hide();
    }, 150);
  };

  useSafeLayoutEffect(() => {
    hide();
    const description = descriptionRef.current;
    let width = -1;
    let height = -1;
    const measure = () => {
      if (description !== null) {
        if (width !== description.clientWidth || height !== description.clientHeight) hide();
        width = description.clientWidth;
        height = description.clientHeight;
        setTruncated(description.scrollHeight > description.clientHeight);
      }
    };
    measure();
    const observer = new ResizeObserver(measure);
    if (description !== null) observer.observe(description);
    const dismiss = (event: Event) => {
      if (event.target instanceof Node && popoverRef.current?.contains(event.target)) return;
      hide();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (timerRef.current === undefined && !popoverRef.current?.matches(":popover-open")) return;
      event.preventDefault();
      event.stopPropagation();
      hide();
    };
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("keydown", dismissOnEscape, true);
    return () => {
      clearTimer();
      observer.disconnect();
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("keydown", dismissOnEscape, true);
    };
  }, [props.description, clearTimer, hide]);

  return (
    <>
      <p
        ref={descriptionRef}
        className="studio-detail-description"
        tabIndex={truncated ? 0 : undefined}
        aria-describedby={id}
        onMouseEnter={() => {
          hoveredRef.current = true;
          clearTimer();
          if (truncated) timerRef.current = setTimeout(show, 400);
        }}
        onMouseLeave={() => {
          hoveredRef.current = false;
          scheduleHide();
        }}
        onFocus={show}
        onBlur={scheduleHide}
      >
        {props.description}
      </p>
      <span
        ref={popoverRef}
        id={id}
        className="studio-detail-description-popover"
        popover="auto"
        role="tooltip"
        onMouseEnter={() => {
          hoveredRef.current = true;
          clearTimer();
        }}
        onMouseLeave={() => {
          hoveredRef.current = false;
          scheduleHide();
        }}
      >
        {props.description}
      </span>
    </>
  );
}
