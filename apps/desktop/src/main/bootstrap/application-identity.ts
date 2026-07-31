const DESKTOP_APPLICATION_ID = "com.pqpo.pragma";

// Electron uses its internal application name to identify macOS Safe Storage
// keychain material. Keep this stable independently of the user-visible product name.
const SAFE_STORAGE_APPLICATION_NAME = "Pragma Desktop";

interface DesktopApplicationIdentityHost {
  setName(name: string): void;
  setAppUserModelId(id: string): void;
}

export function configureDesktopApplicationIdentity(
  application: DesktopApplicationIdentityHost,
  platform: NodeJS.Platform = process.platform,
): void {
  application.setName(SAFE_STORAGE_APPLICATION_NAME);
  if (platform === "win32") {
    application.setAppUserModelId(DESKTOP_APPLICATION_ID);
  }
}
