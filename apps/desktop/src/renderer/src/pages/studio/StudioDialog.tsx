import { ConfirmationDialog, Dialog } from "../../components/Dialog.tsx";
import { CharacterCount } from "../../components/CharacterCount.tsx";

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
  return (
    <ConfirmationDialog
      title={props.title}
      description={props.description}
      cancelLabel={props.cancelLabel}
      confirmLabel={props.confirmLabel}
      busyLabel={props.busyLabel}
      busy={props.busy}
      tone={props.action === "move" ? "primary" : "danger"}
      onCancel={props.onCancel}
      onConfirm={props.onConfirm}
    />
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
  readonly hint?: string | undefined;
  readonly countValue?: string | undefined;
  readonly maxLength?: number | undefined;
  readonly invalid?: boolean | undefined;
  readonly onChange: (value: string) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  return (
    <Dialog
      title={props.title}
      description={props.description}
      busy={props.busy}
      onCancel={props.onCancel}
      className="studio-text-input-dialog"
      footer={
        <>
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
            form="studio-text-input-dialog-form"
            disabled={props.busy || props.invalid || props.value.trim() === ""}
          >
            {props.busy ? props.busyLabel : props.confirmLabel}
          </button>
        </>
      }
    >
      <form
        id="studio-text-input-dialog-form"
        onSubmit={(event) => {
          event.preventDefault();
          if (!props.busy && !props.invalid && props.value.trim() !== "") props.onConfirm();
        }}
      >
        <label>
          <span>{props.label}</span>
          <input
            data-dialog-initial-focus
            value={props.value}
            disabled={props.busy}
            aria-invalid={props.invalid || undefined}
            onChange={(event) => props.onChange(event.target.value)}
          />
        </label>
        {props.hint !== undefined || props.maxLength !== undefined ? (
          <div className="studio-text-input-dialog-meta">
            {props.hint === undefined ? <span /> : <small>{props.hint}</small>}
            {props.maxLength === undefined ? null : (
              <CharacterCount
                value={props.countValue ?? props.value}
                max={props.maxLength}
                trim={false}
              />
            )}
          </div>
        ) : null}
        {props.error ? (
          <p className="form-error" role="alert">
            {props.error}
          </p>
        ) : null}
      </form>
    </Dialog>
  );
}
