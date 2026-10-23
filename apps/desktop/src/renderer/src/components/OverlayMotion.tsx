import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

const OverlayMotionContext = createContext(false);
const OverlayOpenContext = createContext(true);
const OVERLAY_MOTION_MS = 120;

/** Opt a product surface and its portals into the same overlay motion. */
export function OverlayMotionScope(props: { readonly children: ReactNode }) {
  return <OverlayMotionContext value>{props.children}</OverlayMotionContext>;
}

export function useOverlayMotion(requestedOpen: boolean) {
  const enabled = useContext(OverlayMotionContext);
  const parentOpen = useContext(OverlayOpenContext);
  const open = requestedOpen && parentOpen;
  const [retained, setRetained] = useState(open);

  useEffect(() => {
    if (!enabled) return;
    if (open) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    const timeout = window.setTimeout(() => setRetained(false), OVERLAY_MOTION_MS);
    return () => window.clearTimeout(timeout);
  }, [enabled, open, retained]);

  return {
    present: open || (enabled && retained),
    attributes: (kind: "menu" | "dialog" | "backdrop") =>
      enabled
        ? ({
            "data-ui-motion": kind,
            "data-ui-motion-state": open ? "open" : "closed",
            "aria-hidden": !open,
            inert: !open,
          } as const)
        : {},
  };
}

/** Keep the last open content mounted until its closing animation finishes. */
export function OverlayPresence(props: { readonly open: boolean; readonly children: ReactNode }) {
  const enabled = useContext(OverlayMotionContext);
  const parentOpen = useContext(OverlayOpenContext);
  const open = props.open && parentOpen;
  const { present } = useOverlayMotion(open);
  const [lastChildren, setLastChildren] = useState(props.children);

  useLayoutEffect(() => {
    if (!enabled) return;
    if (open) setLastChildren(props.children);
    else if (!present) setLastChildren(null);
  }, [enabled, open, props.children, present]);

  if (!present) return null;
  return (
    <OverlayOpenContext value={open}>{open ? props.children : lastChildren}</OverlayOpenContext>
  );
}

export function useDialogMotion() {
  const open = useContext(OverlayOpenContext);
  const motion = useOverlayMotion(open);
  return { ...motion, open };
}
