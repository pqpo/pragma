import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("electron", () => ({ ipcRenderer: { invoke: mocks.invoke } }));

import { invokeMutation } from "./invoke-mutation.ts";

describe("invokeMutation", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("returns successful mutation values", async () => {
    mocks.invoke.mockResolvedValue({ ok: true, value: { revision: 3 } });

    await expect(invokeMutation("pragma-project:get")).resolves.toEqual({ revision: 3 });
  });

  it("rejects with bridge-safe structured error data", async () => {
    const error = {
      code: "resource_referenced",
      message: "The resource is referenced.",
      diagnostics: [],
      referencedBy: [
        { ref: "expert:1xddvess309a6gme", name: "Code reviewer" },
        { ref: "flow:ceq0qxcgdv75wg6b", name: "Issue reporter" },
      ],
    };
    mocks.invoke.mockResolvedValue({ ok: false, error });

    await expect(invokeMutation("pragma-project:delete", {})).rejects.toEqual(error);
  });

  it("rejects extension refs that cannot identify a referencing project resource", async () => {
    mocks.invoke.mockResolvedValue({
      ok: false,
      error: {
        code: "resource_referenced",
        message: "The resource is referenced.",
        diagnostics: [],
        referencedBy: [{ ref: "action:review@v1", name: "Review action" }],
      },
    });

    await expect(invokeMutation("pragma-project:delete", {})).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});
