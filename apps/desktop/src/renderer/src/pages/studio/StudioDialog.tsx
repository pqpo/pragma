import { ArrowCounterClockwise, ArrowRight, Trash } from "@phosphor-icons/react";
import { useId } from "react";

export function StudioConfirmationDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly busyLabel: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly action?: "delete" | "reset" | "move" | undefined;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const ConfirmIcon =
    props.action === "reset" ? ArrowCounterClockwise : props.action === "move" ? ArrowRight : Trash;
  return (
    <div className="capability-confirm-backdrop">
      <section
        className="capability-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onCancel();
        }}
      >
        <h2 id={titleId}>{props.title}</h2>
        <p id={descriptionId}>{props.description}</p>
        <footer>
          <button
            className="secondary-button"
            type="button"
            disabled={props.busy}
            autoFocus
            onClick={props.onCancel}
          >
            {props.cancelLabel}
          </button>
          <button
            className={props.action === "move" ? "primary-button" : "danger-button"}
            type="button"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            <ConfirmIcon size={17} /> {props.busy ? props.busyLabel : props.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function StudioTextInputDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly label: string;
  readonly value: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly busyLabel: string;
  readonly busy: boolean;
  readonly error?: string | null | undefined;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  return (
    <div className="capability-confirm-backdrop">
      <form
        className="capability-confirm-dialog studio-text-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.busy && props.value.trim() !== "") props.onConfirm();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onCancel();
        }}
      >
        <h2 id={titleId}>{props.title}</h2>
        <p id={descriptionId}>{props.description}</p>
        <label>
          {props.label}
          <input
            autoFocus
            value={props.value}
            disabled={props.busy}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </label>
        {props.error ? (
          <p className="form-error" role="alert">
            {props.error}
          </p>
        ) : null}
        <footer>
          <button
            className="secondary-button"
            type="button"
            disabled={props.busy}
            onClick={props.onCancel}
          >
            {props.cancelLabel}
          </button>
          <button
            className="primary-button"
            type="submit"
            disabled={props.busy || props.value.trim() === ""}
          >
            {props.busy ? props.busyLabel : props.confirmLabel}
          </button>
        </footer>
      </form>
    </div>
  );
}
