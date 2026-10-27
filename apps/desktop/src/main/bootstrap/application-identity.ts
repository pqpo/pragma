import { join } from "node:path";
import { getDistribution } from "@pragma/shared/distribution";

// Electron uses its internal application name to identify macOS Safe Storage
// keychain material. Keep this stable independently of the user-visible product name.

interface DesktopApplicationIdentityHost {
  readonly isPackaged?: boolean;
  getPath(name: "appData"): string;
  setPath(name: "userData" | "sessionData", path: string): void;
  setName(name: string): void;
  setAppUserModelId(id: string): void;
}

export function configureDesktopApplicationIdentity(
  application: DesktopApplicationIdentityHost,
  platform: NodeJS.Platform = process.platform,
): void {
  const distribution = getDistribution();
  application.setName(distribution.applicationName);
  const userData = join(
    application.getPath("appData"),
    application.isPackaged === false
      ? distribution.userDataDevelopmentDirectory
      : distribution.userDataDirectory,
  );
  application.setPath("userData", userData);
  application.setPath("sessionData", userData);
  if (platform === "win32") {
    application.setAppUserModelId(distribution.applicationId);
  }
}
