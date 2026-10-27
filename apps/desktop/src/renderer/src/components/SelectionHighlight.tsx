import { useLayoutEffect, useRef, useState } from "react";

type SelectionBounds = { top: number; left: number; width: number; height: number };

/** Place inside a selection-highlight-scope; mark its choices with data-selection-active. */
export function SelectionHighlight({ activeKey }: { readonly activeKey: string | null }) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const [bounds, setBounds] = useState<SelectionBounds | null>(null);

  useLayoutEffect(() => {
    const scope = anchorRef.current?.parentElement;
    if (scope === undefined || scope === null) return;
    let frame: number | undefined;
    const measure = () => {
      const selected = scope.querySelector<HTMLElement>('[data-selection-active="true"]');
      if (selected === null || selected.getClientRects().length === 0) {
        setBounds(null);
        return;
      }
      // Rect differences work for nested choices (More menu, grouped and scrolling lists).
      const parentRect = scope.getBoundingClientRect();
      const rect = selected.getBoundingClientRect();
      const next = {
        top: rect.top - parentRect.top + scope.scrollTop - scope.clientTop,
        left: rect.left - parentRect.left + scope.scrollLeft - scope.clientLeft,
        width: rect.width,
        height: rect.height,
      };
      setBounds((current) =>
        current?.top === next.top &&
        current.left === next.left &&
        current.width === next.width &&
        current.height === next.height
          ? current
          : next,
      );
    };
    const scheduleMeasure = () => {
      if (frame !== undefined) return;
      frame = requestAnimationFrame(() => {
        frame = undefined;
        measure();
      });
    };
    const resizeObserver = new ResizeObserver(scheduleMeasure);
    const observeSizes = () => {
      resizeObserver.disconnect();
      resizeObserver.observe(scope);
      scope
        .querySelectorAll("[data-selection-active]")
        .forEach((item) => resizeObserver.observe(item));
    };
    const mutationObserver = new MutationObserver(() => {
      observeSizes();
      scheduleMeasure();
    });
    measure();
    observeSizes();
    mutationObserver.observe(scope, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ["class", "data-selection-active", "hidden"],
    });
    return () => {
      resizeObserver.disconnect();
      mutationObserver.disconnect();
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [activeKey]);

  return (
    <>
      <span ref={anchorRef} hidden aria-hidden="true" />
      {bounds !== null ? (
        <span
          className="selection-highlight"
          aria-hidden="true"
          style={{
            transform: `translate(${bounds.left}px, ${bounds.top}px)`,
            width: bounds.width,
            height: bounds.height,
          }}
        />
      ) : null}
    </>
  );
}
