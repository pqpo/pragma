import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { expect, it, vi } from "vitest";
import { invokeMissionOwner } from "../src/mission-owner-process.ts";
import { runMissionOwnerRequest } from "../src/mission-owner-runtime.ts";
import { runCli, type CliLocalHost } from "../src/index.ts";
import { createIntegrationError, type CliOwnerFrame } from "@pragma/shared/integration";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: vi.fn(),
}));
vi.mock("../src/composition/default.ts", () => ({
  createCliLocalHost: (input: { localHost?: CliLocalHost }) =>
    input.localHost ?? { dispose: async () => {} },
}));
const id = "11111111-1111-4111-8111-111111111111";

it.each([
  {
    argv: [
      "flow",
      "run",
      "flow:aaaaaaaaaaaaaaaa",
      "--workspace",
      "/workspace",
      "--input-json",
      "-",
    ],
    bytes: Buffer.from("invalid JSON"),
    code: "INPUT_SCHEMA_INVALID",
  },
  {
    argv: ["expert", "run", "expert:aaaaaaaaaaaaaaaa", "--workspace", "/workspace", "--input", "-"],
    bytes: Buffer.from([0xc0, 0x80]),
    code: "INVALID_ARGUMENT",
  },
  {
    argv: ["mission", "respond", id, "--interaction", "approval", "--answers-json", "-"],
    bytes: Buffer.from("invalid JSON"),
    code: "INVALID_ARGUMENT",
  },
])(
  "keeps the normal input error contract for an owner request ($code)",
  async ({ argv, bytes, code }) => {
    const start = vi.fn();
    const submit = vi.fn();
    const host = {
      run: { start },
      missionControl: { submit },
      resolveWorkspace: async () => ({}),
    } as unknown as CliLocalHost;
    const stdout: string[] = [];
    await runCli(
      [...argv, "--json"],
      { writeStdout: (text) => stdout.push(text), writeStderr: () => {} },
      { localHost: host, readStdin: async () => bytes },
    );
    expect(JSON.parse(stdout[0]!).error.code).toBe(code);
    const frames: CliOwnerFrame[] = [];
    await runMissionOwnerRequest(
      {
        schemaVersion: "pragma.cli-owner-request/v1",
        requestId: id,
        argv: [...argv, "--json"],
        stdin: bytes.toString("base64"),
      },
      () => host,
      async (frame) => {
        frames.push(frame);
      },
    );
    expect(frames.at(-1)).toMatchObject({ type: "failed", error: { code } });
    expect(start).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
  },
);

it("prints the generated request ID before an owner acceptance failure", async () => {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    disconnect: vi.fn(),
    unref: vi.fn(),
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
  const stderr: string[] = [];
  const result = runCli(["mission", "send", id, "--prompt", "hello", "--wait-timeout", "1"], {
    writeStdout: () => {},
    writeStderr: (value) => stderr.push(value),
  });
  expect(stderr.join("")).toMatch(/Request ID: [0-9a-f-]{36}/u);
  child.emit("message", {
    type: "failed",
    error: createIntegrationError({
      code: "COMMAND_ACCEPTANCE_TIMEOUT",
      category: "conflict",
      message: "Retry the same request ID.",
    }),
  });
  expect(await result).not.toBe(0);
});

it("reports invalid requests and Host creation errors through the IPC failure contract", async () => {
  const frames: CliOwnerFrame[] = [];
  const send = async (frame: CliOwnerFrame) => {
    frames.push(frame);
  };
  const createHost = vi.fn(() => {
    throw createIntegrationError({
      code: "STORAGE_CORRUPTED",
      category: "protocol",
      message: "Bad settings",
    });
  });
  await runMissionOwnerRequest({}, createHost, send);
  expect(createHost).not.toHaveBeenCalled();
  expect(frames.pop()).toMatchObject({ type: "failed", error: { code: "INVALID_ARGUMENT" } });
  await runMissionOwnerRequest(
    { schemaVersion: "pragma.cli-owner-request/v1", requestId: id, argv: ["version"] },
    createHost,
    send,
  );
  expect(frames.pop()).toMatchObject({ type: "failed", error: { code: "STORAGE_CORRUPTED" } });
});

it("validates the owner request before starting a process", async () => {
  vi.mocked(fork).mockClear();
  await expect(
    invokeMissionOwner({ argv: [], requestId: "invalid", detach: false }),
  ).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
  expect(fork).not.toHaveBeenCalled();
});

it("settles and disconnects when the receipt presenter throws", async () => {
  const child = Object.assign(new EventEmitter(), {
    connected: true,
    disconnect: vi.fn(),
    unref: vi.fn(),
    send: vi.fn(),
  });
  vi.mocked(fork).mockReturnValue(child as unknown as ReturnType<typeof fork>);
  const failure = new Error("receipt output failed");
  const result = invokeMissionOwner({
    argv: [],
    requestId: id,
    detach: false,
    ackTimeoutSeconds: 0.02,
    onStarted: () => {
      throw failure;
    },
  });
  const rejected = expect(result).rejects.toBe(failure);
  child.emit("message", { type: "started", missionId: id });
  await rejected;
  expect(child.disconnect).toHaveBeenCalledOnce();
  expect(child.unref).toHaveBeenCalledOnce();
});
