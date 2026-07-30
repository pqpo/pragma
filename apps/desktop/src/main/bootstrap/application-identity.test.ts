import { describe, expect, it, vi } from "vitest";

import { configureDesktopApplicationIdentity } from "./application-identity.ts";

describe("configureDesktopApplicationIdentity", () => {
  it("keeps the historical internal name for macOS Safe Storage", () => {
    const application = {
      setName: vi.fn(),
      setAppUserModelId: vi.fn(),
    };

    configureDesktopApplicationIdentity(application, "darwin");

    expect(application.setName).toHaveBeenCalledWith("Pragma Desktop");
    expect(application.setAppUserModelId).not.toHaveBeenCalled();
  });

  it("also configures the Windows application id", () => {
    const application = {
      setName: vi.fn(),
      setAppUserModelId: vi.fn(),
    };

    configureDesktopApplicationIdentity(application, "win32");

    expect(application.setName).toHaveBeenCalledWith("Pragma Desktop");
    expect(application.setAppUserModelId).toHaveBeenCalledWith("com.pqpo.pragma");
  });
});
