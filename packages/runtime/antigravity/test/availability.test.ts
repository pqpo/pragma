import { randomUUID } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  runRuntimeCommand: vi.fn(),
}));

vi.mock("@pragma/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@pragma/core")>()),
  runRuntimeCommand: mocks.runRuntimeCommand,
}));

import {
  canUseAntigravityRuntime,
  MINIMUM_ANTIGRAVITY_CLI_VERSION,
  parseAntigravityVersion,
} from "../src/availability.ts";

describe("Antigravity Runtime availability", () => {
  beforeEach(() => {
    mocks.runRuntimeCommand.mockReset();
  });

  it("accepts the current CLI and probes it with updates disabled", async () => {
    mocks.runRuntimeCommand.mockResolvedValue(commandResult("agy version 1.1.11\n"));
    const executablePath = `/opt/agy-${randomUUID()}`;

    await expect(
      canUseAntigravityRuntime({ executablePath, env: { TEST_AUTH: "preserved" } }),
    ).resolves.toMatchObject({
      usable: true,
      details: { executablePath, parsedVersion: "1.1.11" },
    });
    expect(mocks.runRuntimeCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        executablePath,
        args: ["--version"],
        timeoutMs: 5_000,
        env: expect.objectContaining({
          TEST_AUTH: "preserved",
          AGY_CLI_DISABLE_AUTO_UPDATE: "true",
        }),
      }),
    );
  });

  it("rejects versions before the stream-json compatibility floor", async () => {
    mocks.runRuntimeCommand.mockResolvedValue(commandResult("1.1.10\n"));

    await expect(
      canUseAntigravityRuntime({ executablePath: `/opt/agy-${randomUUID()}` }),
    ).resolves.toMatchObject({
      usable: false,
      reason: expect.stringContaining(`Upgrade to ${MINIMUM_ANTIGRAVITY_CLI_VERSION}`),
    });
  });

  it("fails closed for malformed versions, non-zero exits, and spawn errors", async () => {
    mocks.runRuntimeCommand.mockResolvedValueOnce(commandResult("nightly\n"));
    await expect(
      canUseAntigravityRuntime({ executablePath: `/opt/agy-${randomUUID()}` }),
    ).resolves.toMatchObject({ usable: false, reason: expect.stringContaining("unrecognized") });

    mocks.runRuntimeCommand.mockResolvedValueOnce({
      ...commandResult("1.1.11\n"),
      exitCode: 7,
      stderr: "broken",
    });
    await expect(
      canUseAntigravityRuntime({ executablePath: `/opt/agy-${randomUUID()}` }),
    ).resolves.toMatchObject({ usable: false, reason: expect.stringContaining("exit code 7") });

    mocks.runRuntimeCommand.mockRejectedValueOnce(new Error("ENOENT"));
    await expect(
      canUseAntigravityRuntime({ executablePath: `/opt/agy-${randomUUID()}` }),
    ).resolves.toMatchObject({ usable: false, reason: expect.stringContaining("ENOENT") });
  });

  it("coalesces probes for the same executable and spawn implementation", async () => {
    let resolveProbe: ((value: ReturnType<typeof commandResult>) => void) | undefined;
    mocks.runRuntimeCommand.mockImplementationOnce(
      async () =>
        await new Promise<ReturnType<typeof commandResult>>((resolve) => {
          resolveProbe = resolve;
        }),
    );
    const executablePath = `/opt/agy-${randomUUID()}`;
    const first = canUseAntigravityRuntime({ executablePath });
    const second = canUseAntigravityRuntime({ executablePath });

    expect(mocks.runRuntimeCommand).toHaveBeenCalledOnce();
    resolveProbe?.(commandResult("1.1.11\n"));
    await expect(first).resolves.toMatchObject({ usable: true });
    await expect(second).resolves.toMatchObject({ usable: true });
  });

  it("parses prefixed semantic versions", () => {
    expect(parseAntigravityVersion("Antigravity CLI v1.1.11+build.2")).toBe("1.1.11");
    expect(parseAntigravityVersion("unknown")).toBeUndefined();
  });

  it("does not cache failed probe results and bypasses cache when forceRefresh is requested", async () => {
    const executablePath = `/opt/agy-${randomUUID()}`;
    mocks.runRuntimeCommand.mockRejectedValueOnce(new Error("Probe timed out after 5000ms."));
    const failedResult = await canUseAntigravityRuntime({ executablePath });
    expect(failedResult).toMatchObject({ usable: false });

    // A subsequent call should attempt a fresh probe because failed results are not cached
    mocks.runRuntimeCommand.mockResolvedValueOnce(commandResult("1.1.11\n"));
    const retriedResult = await canUseAntigravityRuntime({ executablePath });
    expect(retriedResult).toMatchObject({ usable: true });

    // With usable: true, it should now be cached
    const cachedResult = await canUseAntigravityRuntime({ executablePath });
    expect(cachedResult).toMatchObject({ usable: true });
    // runRuntimeCommand was called 2 times in total (1st failed, 2nd succeeded, 3rd cached)
    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(2);

    // forceRefresh should force a 3rd call
    mocks.runRuntimeCommand.mockResolvedValueOnce(commandResult("1.1.11\n"));
    await canUseAntigravityRuntime({ executablePath, forceRefresh: true });
    expect(mocks.runRuntimeCommand).toHaveBeenCalledTimes(3);
  });
});

function commandResult(stdout: string) {
  return { exitCode: 0, signal: null, stdout, stderr: "" } as const;
}
