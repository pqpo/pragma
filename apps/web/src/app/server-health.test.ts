import { afterEach, describe, expect, it, vi } from "vitest";

import { getServerHealth } from "./server-health.ts";

describe("getServerHealth", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses a valid health response", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ service: "server", status: "ok" }), { status: 200 }),
        ),
    );

    await expect(getServerHealth()).resolves.toEqual({ service: "server", status: "ok" });
  });

  it("rejects non-success responses", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 503 })));

    await expect(getServerHealth()).rejects.toThrow("Health request failed with status 503");
  });

  it("rejects invalid response payloads", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ status: "ok" }), { status: 200 })),
    );

    await expect(getServerHealth()).rejects.toThrow();
  });
});
