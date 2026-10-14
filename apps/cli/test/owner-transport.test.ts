import { EventEmitter } from "node:events";
import { fork } from "node:child_process";
import { expect, it, vi } from "vitest";
import { invokeMissionOwner } from "../src/mission-owner-process.ts";
import { runMissionOwnerRequest } from "../src/mission-owner-runtime.ts";
import { createIntegrationError, type CliOwnerFrame } from "@pragma/shared/integration";

vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  fork: vi.fn(),
}));
const id = "11111111-1111-4111-8111-111111111111";

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
