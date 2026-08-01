import { pragmaUnicodeLength } from "@pragma/shared";

export function CharacterCount(props: {
  readonly value: string;
  readonly max: number;
  readonly className?: string | undefined;
}) {
  return (
    <small className={["field-character-count", props.className].filter(Boolean).join(" ")}>
      {pragmaUnicodeLength(props.value.trim())}/{props.max}
    </small>
  );
}
