import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileMemoryPolicyStore } from "@pragma/memory";
import { describe, expect, it, vi } from "vitest";
import { installMemoryPolicyHandlers } from "./memory-policy-ipc.ts";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
    electron.handlers.set(channel, handler);
  }),
}));
vi.mock("electron", () => ({ ipcMain: { handle: electron.handle } }));

describe("Memory policy IPC", () => {
  it("cancels retrieval before and after committing an asset recall change", async () => {
    const pragmaHome = await mkdtemp(join(tmpdir(), "pragma-memory-policy-ipc-"));
    electron.handlers.clear();
    const policies = createFileMemoryPolicyStore({ pragmaHome });
    const cancel = vi.fn();
    const update = vi.spyOn(policies, "updateOverride");
    try {
      await policies.updateGlobal({
        expectedRevision: 0,
        policy: { enabled: "enabled", capture: "enabled", recall: "enabled", learning: "disabled" },
      });
      installMemoryPolicyHandlers(
        { policies, retrieval: { cancel } } as unknown as Parameters<
          typeof installMemoryPolicyHandlers
        >[0],
        { curator: { subscribeRunChat: vi.fn() }, getWindow: () => null } as unknown as Parameters<
          typeof installMemoryPolicyHandlers
        >[1],
      );
      const result = await electron.handlers.get("memory-policy:asset:update")!(
        {},
        {
          targetRef: { type: "pragma.expert", id: "7k2m9q4v8np6r3dt" },
          expectedRevision: 0,
          policy: { capture: "inherit", recall: "disabled", learning: "inherit" },
        },
      );
      expect(result).toMatchObject({ revision: 1, effective: { recall: false } });
      expect(cancel).toHaveBeenCalledTimes(2);
      expect(cancel.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0]!);
      expect(cancel.mock.invocationCallOrder[1]).toBeGreaterThan(
        update.mock.invocationCallOrder[0]!,
      );
    } finally {
      update.mockRestore();
      electron.handlers.clear();
      await rm(pragmaHome, { recursive: true, force: true });
    }
  });
});
