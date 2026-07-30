export interface DesktopStartupContainer {
  readonly startBackgroundTasks: () => void;
}

export async function startDesktopWindowWithServices<T extends DesktopStartupContainer>(input: {
  readonly createContainer: () => Promise<T>;
  readonly createWindow: () => Promise<void>;
  readonly onContainerReady?: ((container: T) => void) | undefined;
  readonly onContainerError: (error: unknown) => void;
}): Promise<T | undefined> {
  let container: T | undefined;
  try {
    container = await input.createContainer();
    input.onContainerReady?.(container);
  } catch (error) {
    input.onContainerError(error);
  }
  await input.createWindow();
  container?.startBackgroundTasks();
  return container;
}
