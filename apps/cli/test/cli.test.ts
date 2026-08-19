import { describe, expect, it, vi } from "vitest";

import { runCli } from "../src/index.ts";

function createIo() {
  return { writeStdout: vi.fn(), writeStderr: vi.fn() };
}

describe("runCli", () => {
  it("renders version without stderr output", () => {
    const io = createIo();

    expect(runCli(["version"], io)).toBe(0);
    expect(io.writeStdout).toHaveBeenCalledWith(expect.stringContaining("pragma 0.0.0"));
    expect(io.writeStderr).not.toHaveBeenCalled();
  });

  it("rejects unknown commands with the usage exit code", () => {
    const io = createIo();

    expect(runCli(["unknown"], io)).toBe(2);
    expect(io.writeStderr).toHaveBeenCalledWith(
      expect.stringContaining("Unknown command: unknown"),
    );
  });
});
