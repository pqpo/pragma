import { PragmaPaths, type TrashMaintenanceResult } from "@pragma/core";
import { describe, expect, it, vi } from "vitest";

import { createDesktopTrashMaintenance } from "./trash-maintenance.ts";

describe("createDesktopTrashMaintenance", () => {
  it("coalesces requests that arrive while maintenance is running", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const maintain = vi
      .fn<() => Promise<TrashMaintenanceResult>>()
      .mockImplementationOnce(async () => {
        await blocked;
        return result(1);
      })
      .mockResolvedValue(result(0));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const maintenance = createDesktopTrashMaintenance({
      paths: new PragmaPaths({ pragmaHome: "/tmp/pragma-trash-maintenance-test" }),
      logger,
      maintain,
    });

    maintenance.schedule("startup");
    maintenance.schedule("mission-deleted");
    maintenance.schedule("automation-deleted");
    release?.();
    await vi.waitFor(() => expect(maintain).toHaveBeenCalledTimes(2));

    expect(logger.info).toHaveBeenCalledTimes(2);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("logs a failure without preventing a later retry", async () => {
    const maintain = vi
      .fn<() => Promise<TrashMaintenanceResult>>()
      .mockRejectedValueOnce(new Error("busy"))
      .mockResolvedValueOnce(result(1));
    const logger = { info: vi.fn(), warn: vi.fn() };
    const maintenance = createDesktopTrashMaintenance({
      paths: new PragmaPaths({ pragmaHome: "/tmp/pragma-trash-maintenance-retry-test" }),
      logger,
      maintain,
    });

    maintenance.schedule("startup");
    await vi.waitFor(() => expect(logger.warn).toHaveBeenCalledOnce());
    maintenance.schedule("mission-deleted");
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledOnce());

    expect(maintain).toHaveBeenCalledTimes(2);
  });
});

function result(deletedEntries: number): TrashMaintenanceResult {
  return {
    beforeBytes: deletedEntries,
    afterBytes: 0,
    deletedEntries,
    reclaimedBytes: deletedEntries,
  };
}
