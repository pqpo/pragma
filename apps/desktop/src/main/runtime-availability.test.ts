import { describe, expect, it } from "vitest";

import { getRuntimeAvailability } from "./runtime-availability.ts";

describe("getRuntimeAvailability", () => {
  it("always reports the built-in PI runtime as available and maps CLI probe details", async () => {
    const runtimes = await getRuntimeAvailability({
      canUseCodexRuntime: async () => ({
        usable: true,
        details: { executablePath: "/opt/homebrew/bin/codex", version: "codex 1.2.3" },
      }),
      canUseClaudeCodeRuntime: async () => ({
        usable: false,
        reason: "Claude Code CLI is not installed.",
        details: { executablePath: "claude" },
      }),
    });

    expect(runtimes).toEqual([
      { id: "pi", status: "available" },
      {
        id: "codex",
        status: "available",
        executablePath: "/opt/homebrew/bin/codex",
        version: "codex 1.2.3",
      },
      {
        id: "claude-code",
        status: "unavailable",
        executablePath: "claude",
        reason: "Claude Code CLI is not installed.",
      },
    ]);
  });
});
