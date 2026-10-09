import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliLocalHost } from "../src/index.ts";

const composition = vi.hoisted(() => ({ host: {} as CliLocalHost, create: vi.fn() }));
vi.mock("../src/composition/default.ts", () => ({
  createCliLocalHost: (input: { localHost?: CliLocalHost }) => {
    composition.create();
    return input.localHost ?? composition.host;
  },
}));
import { runCli } from "../src/index.ts";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    writeStdout: (s: string) => stdout.push(s),
    writeStderr: (s: string) => stderr.push(s),
  };
}
beforeEach(() => composition.create.mockClear());

describe("CLI process Host shutdown", () => {
  it("settles its production Host before publishing success", async () => {
    let finish = () => undefined as void;
    const pending = new Promise<void>((resolve) => (finish = resolve));
    const dispose = vi.fn(() => pending);
    composition.host = { dispose } as CliLocalHost;
    const output = io();
    const running = runCli(["version", "--format=json"], output);
    await vi.waitFor(() => expect(dispose).toHaveBeenCalledOnce());
    expect(output.stdout).toEqual([]);
    finish();
    expect(await running).toBe(0);
    expect(output.stdout).toHaveLength(1);
  });

  it("reports failed cleanup instead of publishing success", async () => {
    const dispose = vi.fn(async () => {
      throw new Error("Native stop unconfirmed");
    });
    composition.host = { dispose } as CliLocalHost;
    const output = io();
    expect(await runCli(["version", "--format=json"], output)).not.toBe(0);
    expect(dispose).toHaveBeenCalledOnce();
    expect(output.stdout).toHaveLength(1);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ status: "failed" });
  });

  it("leaves injected Host lifetime with its caller and never creates a Host for invalid argv", async () => {
    const dispose = vi.fn(async () => undefined);
    const borrowed = { dispose } as CliLocalHost;
    expect(await runCli(["version"], io(), { localHost: borrowed })).toBe(0);
    expect(await runCli(["version"], io(), { localHost: borrowed })).toBe(0);
    expect(dispose).not.toHaveBeenCalled();
    composition.create.mockClear();
    expect(await runCli(["not-a-command"], io())).not.toBe(0);
    expect(composition.create).not.toHaveBeenCalled();
  });

  it("publishes durable detach acceptance without cancelling its Native run, then closes at process exit", async () => {
    const dispose = vi.fn(async () => undefined);
    const cancel = vi.fn(async () => undefined);
    const missionId = "11111111-1111-4111-8111-111111111111";
    const executionId = "22222222-2222-4222-8222-222222222222";
    composition.host = {
      dispose,
      resolveWorkspace: async (path) => ({
        schemaVersion: "pragma.integration-workspace/v1",
        requestedPath: path,
        canonicalPath: path,
        displayName: "workspace",
        access: { exists: true, readable: true, writable: true },
        source: "explicit",
        identityHash: `sha256:${"a".repeat(64)}`,
      }),
      run: {
        start: async (request) => ({
          request,
          missionId,
          executionId,
          payloadHash: `sha256:${"b".repeat(64)}`,
          disposition: "created",
          outcome: Promise.resolve({
            status: "accepted",
            missionId,
            executionId,
            result: { missionId, executionId },
          }),
          cancel,
        }),
      },
    } as CliLocalHost;
    let shutdown = async () => undefined;
    const output = io();
    expect(
      await runCli(
        [
          "expert",
          "run",
          "expert:0000000000000001",
          "--prompt",
          "hello",
          "--workspace",
          "/tmp",
          "--detach",
          "--format=json",
        ],
        output,
        { onBeforeExit: (operation) => (shutdown = operation) },
      ),
      JSON.stringify(output),
    ).toBe(0);
    expect(JSON.parse(output.stdout[0]!)).toMatchObject({ status: "accepted", missionId });
    expect(cancel).not.toHaveBeenCalled();
    expect(dispose).not.toHaveBeenCalled();
    await shutdown();
    expect(dispose).toHaveBeenCalledOnce();
    expect(cancel).not.toHaveBeenCalled();
  });
});
