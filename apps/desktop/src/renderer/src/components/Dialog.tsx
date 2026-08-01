import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function Dialog(props: {
  readonly title: string;
  readonly description?: string | undefined;
  readonly children?: ReactNode | undefined;
  readonly footer?: ReactNode | undefined;
  readonly className?: string | undefined;
  readonly role?: "dialog" | "alertdialog" | undefined;
  readonly busy?: boolean | undefined;
  readonly onCancel: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const surfaceRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    requestAnimationFrame(() => {
      const preferred = surfaceRef.current?.querySelector<HTMLElement>(
        "[data-dialog-initial-focus], input, textarea, [role=combobox], button",
      );
      preferred?.focus();
    });
    return () => {
      document.body.style.overflow = previousOverflow;
      restoreFocusRef.current?.focus();
    };
  }, []);

  const content = (
    <div
      className="ui-dialog-backdrop"
      role="presentation"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && !props.busy) props.onCancel();
      }}
    >
      <section
        className={["ui-dialog", props.className].filter(Boolean).join(" ")}
        ref={surfaceRef}
        role={props.role ?? "dialog"}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={props.description ? descriptionId : undefined}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) {
            event.preventDefault();
            props.onCancel();
            return;
          }
          if (event.key !== "Tab") return;
          const focusable = focusableElements(surfaceRef.current);
          if (focusable.length === 0) return;
          const first = focusable[0]!;
          const last = focusable.at(-1)!;
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first.focus();
          }
        }}
      >
        <header className="ui-dialog-header">
          <h2 id={titleId}>{props.title}</h2>
          {props.description ? <p id={descriptionId}>{props.description}</p> : null}
        </header>
        {props.children ? <div className="ui-dialog-body">{props.children}</div> : null}
        {props.footer ? <footer className="ui-dialog-footer">{props.footer}</footer> : null}
      </section>
    </div>
  );

  return typeof document === "undefined" ? content : createPortal(content, document.body);
}

export function ConfirmationDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly busyLabel: string;
  readonly busy: boolean;
  readonly tone?: "danger" | "primary" | undefined;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      title={props.title}
      description={props.description}
      role="alertdialog"
      busy={props.busy}
      onCancel={props.onCancel}
      footer={
        <>
          <button
            className="secondary-button"
            type="button"
            disabled={props.busy}
            data-dialog-initial-focus
            onClick={props.onCancel}
          >
            {props.cancelLabel}
          </button>
          <button
            className={props.tone === "primary" ? "primary-button" : "danger-button"}
            type="button"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? props.busyLabel : props.confirmLabel}
          </button>
        </>
      }
    />
  );
}

function focusableElements(root: HTMLElement | null): HTMLElement[] {
  if (root === null) return [];
  return [
    ...root.querySelectorAll<HTMLElement>("button, input, textarea, [role=combobox], [tabindex]"),
  ].filter((element) => !element.hasAttribute("disabled") && element.tabIndex >= 0);
}
