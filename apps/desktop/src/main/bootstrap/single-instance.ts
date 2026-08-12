export interface DesktopSingleInstanceWindow {
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export interface DesktopSingleInstanceHost {
  requestSingleInstanceLock(): boolean;
  quit(): void;
  on(event: "second-instance", listener: () => void): unknown;
}

export function enforceDesktopSingleInstance(
  application: DesktopSingleInstanceHost,
  getWindow: () => DesktopSingleInstanceWindow | null,
): boolean {
  if (!application.requestSingleInstanceLock()) {
    application.quit();
    return false;
  }

  application.on("second-instance", () => {
    const window = getWindow();
    if (window === null) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  });
  return true;
}
