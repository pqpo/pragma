type ComposerKeyboardEvent = {
  readonly isComposing?: boolean | undefined;
  readonly key: string;
  readonly keyCode?: number | undefined;
  readonly shiftKey: boolean;
};

export function shouldSubmitComposerOnEnter(event: ComposerKeyboardEvent): boolean {
  return (
    event.key === "Enter" && !event.shiftKey && event.isComposing !== true && event.keyCode !== 229
  );
}
