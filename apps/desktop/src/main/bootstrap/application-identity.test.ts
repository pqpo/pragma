import { DEFAULT_DISTRIBUTION } from "@pragma/shared/distribution";
import { afterEach, describe, expect, it, vi } from "vitest";

import { configureDesktopApplicationIdentity } from "./application-identity.ts";

afterEach(() => vi.unstubAllGlobals());

describe("configureDesktopApplicationIdentity", () => {
  it("keeps the historical internal name for macOS Safe Storage", () => {
    const application = {
      getPath: () => "/app-data",
      setPath: vi.fn(),
      setName: vi.fn(),
      setAppUserModelId: vi.fn(),
    };

    configureDesktopApplicationIdentity(application, "darwin");

    expect(application.setPath).toHaveBeenCalledWith("userData", "/app-data/Pragma Desktop");
    expect(application.setName).toHaveBeenCalledWith("Pragma Desktop");
    expect(application.setAppUserModelId).not.toHaveBeenCalled();
  });

  it("also configures the Windows application id", () => {
    const application = {
      getPath: () => "/app-data",
      setPath: vi.fn(),
      setName: vi.fn(),
      setAppUserModelId: vi.fn(),
    };

    configureDesktopApplicationIdentity(application, "win32");

    expect(application.setPath).toHaveBeenCalledWith("userData", "/app-data/Pragma Desktop");
    expect(application.setName).toHaveBeenCalledWith("Pragma Desktop");
    expect(application.setAppUserModelId).toHaveBeenCalledWith("com.pqpo.pragma");
  });
  it("isolates derived development Electron data before the instance lock", () => {
    vi.stubGlobal("__PRAGMA_DISTRIBUTION__", {
      ...DEFAULT_DISTRIBUTION,
      applicationId: "com.acme.pragma",
      applicationName: "Acme Pragma",
      userDataDevelopmentDirectory: "Acme Pragma Dev",
    });
    const application = {
      isPackaged: false,
      getPath: () => "/app-data",
      setPath: vi.fn(),
      setName: vi.fn(),
      setAppUserModelId: vi.fn(),
    };
    configureDesktopApplicationIdentity(application, "win32");
    expect(application.setPath).toHaveBeenCalledWith("userData", "/app-data/Acme Pragma Dev");
    expect(application.setName).toHaveBeenCalledWith("Acme Pragma");
    expect(application.setAppUserModelId).toHaveBeenCalledWith("com.acme.pragma");
  });
});
