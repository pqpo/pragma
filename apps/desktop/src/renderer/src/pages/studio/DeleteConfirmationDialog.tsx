import { ArrowCounterClockwise, Trash } from "@phosphor-icons/react";

export function DeleteConfirmationDialog(props: {
  readonly title: string;
  readonly description: string;
  readonly cancelLabel: string;
  readonly confirmLabel: string;
  readonly deletingLabel: string;
  readonly busy: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
  readonly action?: "delete" | "reset" | undefined;
}) {
  const ConfirmIcon = props.action === "reset" ? ArrowCounterClockwise : Trash;
  return (
    <div className="capability-confirm-backdrop">
      <section
        className="capability-confirm-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="studio-delete-confirm-title"
        aria-describedby="studio-delete-confirm-description"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !props.busy) props.onCancel();
        }}
      >
        <h2 id="studio-delete-confirm-title">{props.title}</h2>
        <p id="studio-delete-confirm-description">{props.description}</p>
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
            className="danger-button"
            type="button"
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            <ConfirmIcon size={17} /> {props.busy ? props.deletingLabel : props.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
