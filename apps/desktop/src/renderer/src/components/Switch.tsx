export function Switch(props: {
  readonly checked: boolean;
  readonly ariaLabel: string;
  readonly disabled?: boolean | undefined;
  readonly onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className={props.checked ? "ui-switch is-checked" : "ui-switch"}
      type="button"
      role="switch"
      aria-label={props.ariaLabel}
      aria-checked={props.checked}
      disabled={props.disabled}
      onClick={() => props.onChange(!props.checked)}
    >
      <span aria-hidden="true" />
    </button>
  );
}
