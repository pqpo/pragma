import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useState,
  type ReactNode,
} from "react";

const OverlayOpenContext = createContext(true);
const OVERLAY_MOTION_MS = 120;

export function useOverlayMotion(requestedOpen: boolean) {
  const parentOpen = useContext(OverlayOpenContext);
  const open = requestedOpen && parentOpen;
  const [retained, setRetained] = useState(open);

  useEffect(() => {
    if (open) {
      setRetained(true);
      return;
    }
    if (!retained) return;
    const timeout = window.setTimeout(() => setRetained(false), OVERLAY_MOTION_MS);
    return () => window.clearTimeout(timeout);
  }, [open, retained]);

  return {
    present: open || retained,
    attributes: (kind: "menu" | "dialog" | "backdrop") =>
      ({
        "data-ui-motion": kind,
        "data-ui-motion-state": open ? "open" : "closed",
        "aria-hidden": !open,
        inert: !open,
      }) as const,
  };
}

/** Keep the last open content mounted until its closing animation finishes. */
export function OverlayPresence(props: { readonly open: boolean; readonly children: ReactNode }) {
  const parentOpen = useContext(OverlayOpenContext);
  const open = props.open && parentOpen;
  const { present } = useOverlayMotion(open);
  const [lastChildren, setLastChildren] = useState(props.children);

  useLayoutEffect(() => {
    if (open) setLastChildren(props.children);
    else if (!present) setLastChildren(null);
  }, [open, props.children, present]);

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
