/** Electron must not quit until the shared Host has released its exact owners. */
export function installDesktopShutdown(input: {
  readonly app: {
    on(event: "before-quit", listener: (event: { preventDefault(): void }) => void): unknown;
    quit(): void;
  };
  readonly dispose: () => Promise<void>;
  readonly reportFailure: (error: unknown) => void;
}): void {
  let completed = false;
  let pending: Promise<void> | undefined;
  input.app.on("before-quit", (event) => {
    if (completed) return;
    event.preventDefault();
    if (pending !== undefined) return;
    pending = Promise.resolve()
      .then(input.dispose)
      .then(
        () => {
          completed = true;
          input.app.quit();
        },
        (error: unknown) => {
          pending = undefined;
          input.reportFailure(error);
        },
      );
  });
}
