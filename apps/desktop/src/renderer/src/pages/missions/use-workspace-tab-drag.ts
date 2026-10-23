import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent,
  type PointerEvent,
} from "react";

interface TabSlot {
  element: HTMLElement;
  path: string;
  left: number;
  width: number;
}

interface TabDrag {
  pointerId: number;
  capture: HTMLElement;
  container: HTMLElement;
  slots: TabSlot[];
  index: number;
  targetIndex: number;
  startX: number;
  startY: number;
  clientX: number;
  grabOffset: number;
  scale: number;
  moved: boolean;
  frame: number;
  previousTime: number;
}

/** Preview reordering with transforms; persist the order only after dropping. */
export function useWorkspaceTabDrag(
  paths: readonly string[],
  onMove: (path: string, target: string, placement: "before" | "after") => void,
) {
  const [draggingPath, setDraggingPath] = useState<string | null>(null);
  const dragRef = useRef<TabDrag | null>(null);
  const suppressClickRef = useRef(false);
  const settleRef = useRef<{ element: HTMLElement; left: number }[] | null>(null);
  const animationsRef = useRef<Animation[]>([]);
  const onMoveRef = useRef(onMove);
  onMoveRef.current = onMove;

  const finish = (commit: boolean) => {
    const drag = dragRef.current;
    if (drag === null) return;
    dragRef.current = null;
    cancelAnimationFrame(drag.frame);
    suppressClickRef.current = drag.moved;
    if (drag.moved) {
      settleRef.current = drag.slots.map(({ element }) => ({
        element,
        left: element.getBoundingClientRect().left,
      }));
      if (commit && drag.targetIndex !== drag.index) {
        onMoveRef.current(
          drag.slots[drag.index]!.path,
          drag.slots[drag.targetIndex]!.path,
          drag.targetIndex > drag.index ? "after" : "before",
        );
      }
      setDraggingPath(null);
    }
    if (drag.capture.hasPointerCapture(drag.pointerId))
      drag.capture.releasePointerCapture(drag.pointerId);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  useLayoutEffect(() => {
    const positions = settleRef.current;
    if (positions === null) return;
    settleRef.current = null;
    for (const { element } of positions) {
      element.style.transition = "none";
      element.style.removeProperty("transform");
    }
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const { element, left } of positions) {
      const bounds = element.getBoundingClientRect();
      const scale = bounds.width / Number.parseFloat(getComputedStyle(element).width);
      const offset = (left - bounds.left) / scale;
      if (!reduceMotion && element.isConnected && Math.abs(offset) > 0.5) {
        animationsRef.current.push(
          element.animate(
            [{ transform: `translateX(${offset}px)` }, { transform: "translateX(0)" }],
            { duration: 160, easing: "ease-out" },
          ),
        );
      }
    }
    for (const { element } of positions) element.style.removeProperty("transition");
  });

  useEffect(() => {
    const cancel = () => finishRef.current(false);
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dragRef.current !== null) {
        event.preventDefault();
        cancel();
      }
    };
    window.addEventListener("blur", cancel);
    window.addEventListener("resize", cancel);
    window.addEventListener("keydown", keyDown);
    return () => {
      window.removeEventListener("blur", cancel);
      window.removeEventListener("resize", cancel);
      window.removeEventListener("keydown", keyDown);
      if (dragRef.current !== null) cancelAnimationFrame(dragRef.current.frame);
      animationsRef.current.forEach((animation) => animation.cancel());
    };
  }, []);

  // Live updates can add or close tabs while a pointer is held. Discard stale geometry.
  useLayoutEffect(() => {
    const drag = dragRef.current;
    if (drag !== null && drag.slots.map(({ path }) => path).join("\0") !== paths.join("\0"))
      finishRef.current(false);
  }, [paths]);

  const update = (drag: TabDrag, time: number) => {
    const rect = drag.container.getBoundingClientRect();
    const elapsed =
      drag.previousTime === 0 ? 0 : Math.max(0, Math.min(time - drag.previousTime, 32));
    drag.previousTime = Math.max(drag.previousTime, time);
    const edge = Math.min(40 * drag.scale, rect.width / 4);
    const direction =
      drag.clientX < rect.left + edge
        ? -Math.min(1, (rect.left + edge - drag.clientX) / edge)
        : drag.clientX > rect.right - edge
          ? Math.min(1, (drag.clientX - rect.right + edge) / edge)
          : 0;
    drag.container.scrollLeft += (direction * elapsed * 0.6) / drag.scale;
    const dragged = drag.slots[drag.index]!;
    const totalWidth = drag.slots.reduce((sum, slot) => sum + slot.width, 0);
    const left = Math.max(
      0,
      Math.min(
        totalWidth - dragged.width,
        (drag.clientX - rect.left) / drag.scale + drag.container.scrollLeft - drag.grabOffset,
      ),
    );
    const others = drag.slots.filter((_, index) => index !== drag.index);
    drag.targetIndex = drag.index;
    for (const [index, slot] of drag.slots.entries()) {
      const midpoint = slot.left + slot.width / 2;
      if (index < drag.index && left < midpoint) drag.targetIndex--;
      if (index > drag.index && left + dragged.width > midpoint) drag.targetIndex++;
    }
    const preview = [...others];
    preview.splice(drag.targetIndex, 0, dragged);
    let nextLeft = 0;
    for (const slot of preview) {
      slot.element.style.transform = `translateX(${slot === dragged ? left - slot.left : nextLeft - slot.left}px)`;
      nextLeft += slot.width;
    }
  };

  const tick = (time: number) => {
    const drag = dragRef.current;
    if (drag === null || !drag.moved) return;
    update(drag, time);
    drag.frame = requestAnimationFrame(tick);
  };

  return {
    draggingPath,
    handlers: {
      onPointerDown: (event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current !== null) return;
        const target = event.target as HTMLElement;
        if (
          event.button !== 0 ||
          event.pointerType !== "mouse" ||
          target.closest(".mission-workspace-close")
        )
          return;
        const slot = target.closest<HTMLElement>(".mission-workspace-tab-slot");
        const capture = slot?.querySelector<HTMLElement>(".mission-workspace-tab");
        if (slot === null || slot === undefined || capture == null) return;
        suppressClickRef.current = false;
        animationsRef.current.forEach((animation) => animation.cancel());
        animationsRef.current = [];
        const container = event.currentTarget;
        const rect = container.getBoundingClientRect();
        const scale = rect.width / Number.parseFloat(getComputedStyle(container).width);
        const slots = [
          ...container.querySelectorAll<HTMLElement>(".mission-workspace-tab-slot"),
        ].map((element) => {
          const bounds = element.getBoundingClientRect();
          return {
            element,
            path: element.dataset.workspacePath!,
            left: (bounds.left - rect.left) / scale + container.scrollLeft,
            width: bounds.width / scale,
          };
        });
        const index = slots.findIndex(({ element }) => element === slot);
        capture.setPointerCapture(event.pointerId);
        dragRef.current = {
          pointerId: event.pointerId,
          capture,
          container,
          slots,
          index,
          targetIndex: index,
          startX: event.clientX,
          startY: event.clientY,
          clientX: event.clientX,
          grabOffset: (event.clientX - slot.getBoundingClientRect().left) / scale,
          scale,
          moved: false,
          frame: 0,
          previousTime: 0,
        };
      },
      onPointerMove: (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag === null || drag.pointerId !== event.pointerId) return;
        if (event.buttons !== 1) {
          finish(false);
          return;
        }
        drag.clientX = event.clientX;
        if (!drag.moved) {
          if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 5) return;
          drag.moved = true;
          setDraggingPath(drag.slots[drag.index]!.path);
          drag.frame = requestAnimationFrame(tick);
        }
        event.preventDefault();
        update(drag, performance.now());
      },
      onPointerUp: (event: PointerEvent<HTMLDivElement>) => {
        const drag = dragRef.current;
        if (drag?.pointerId !== event.pointerId) return;
        if (drag.moved) {
          drag.clientX = event.clientX;
          update(drag, performance.now());
        }
        finish(true);
      },
      onPointerCancel: (event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) finish(false);
      },
      onLostPointerCapture: (event: PointerEvent<HTMLDivElement>) => {
        if (dragRef.current?.pointerId === event.pointerId) finish(false);
      },
      onClickCapture: (event: MouseEvent<HTMLDivElement>) => {
        if (!suppressClickRef.current) return;
        event.preventDefault();
        event.stopPropagation();
        suppressClickRef.current = false;
      },
    },
  };
}
