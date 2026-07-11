import { describe, expect, it } from "vitest";

import { resolveCodexExecutablePath } from "../src/executable.ts";

describe("resolveCodexExecutablePath", () => {
  it("preserves an explicitly configured executable path", () => {
    expect(
      resolveCodexExecutablePath({
        executablePath: "/custom/codex",
        isExecutable: () => false,
      }),
    ).toBe("/custom/codex");
  });

  it("resolves Codex from the effective PATH", () => {
    expect(
      resolveCodexExecutablePath({
        env: { PATH: "/first:/second" },
        isExecutable: (path) => path === "/second/codex",
      }),
    ).toBe("/second/codex");
  });

  it("finds the standalone Codex installation when PATH omits ~/.local/bin", () => {
    expect(
      resolveCodexExecutablePath({
        env: { PATH: "/usr/local/bin" },
        homeDirectory: "/Users/pragma",
        isExecutable: (path) => path === "/Users/pragma/.local/bin/codex",
      }),
    ).toBe("/Users/pragma/.local/bin/codex");
  });

  it("falls back to the bare command when no known executable exists", () => {
    expect(
      resolveCodexExecutablePath({
        env: { PATH: "/usr/local/bin" },
        homeDirectory: "/Users/pragma",
        isExecutable: () => false,
      }),
    ).toBe("codex");
  });
});
