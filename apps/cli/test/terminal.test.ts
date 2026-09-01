import { EventEmitter } from "node:events";
import { ReadStream as TtyReadStream } from "node:tty";

import type { HumanInteractionRequestEnvelope } from "@pragma/shared/integration";
import { describe, expect, it, vi } from "vitest";

import {
  collectHumanInteraction,
  controllingTerminalPath,
  readSensitiveLine,
  type TerminalPort,
} from "../src/terminal.ts";

class FakeTtyInput extends EventEmitter {
  readonly rawModes: boolean[] = [];

  setRawMode(enabled: boolean): this {
    this.rawModes.push(enabled);
    return this;
  }

  setEncoding(): this {
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }
}

function output() {
  return { write: vi.fn(() => true) } as unknown as NodeJS.WritableStream;
}

function rawInput(): FakeTtyInput {
  return new FakeTtyInput();
}

describe("controlling TTY interaction", () => {
  it("uses the platform controlling terminal path", () => {
    expect(controllingTerminalPath("darwin")).toBe("/dev/tty");
    expect(controllingTerminalPath("win32")).toBe("CONIN$");
  });

  it.each([
    ["success", (input: FakeTtyInput) => input.emit("data", "secret\n"), undefined],
    [
      "ctrl-c",
      (input: FakeTtyInput) => input.emit("data", "\u0003"),
      "Terminal input interrupted.",
    ],
    [
      "error",
      (input: FakeTtyInput) => input.emit("error", new Error("read failed")),
      "read failed",
    ],
    ["stream close", (input: FakeTtyInput) => input.emit("close"), "Controlling terminal closed."],
  ] as const)("restores raw mode on %s", async (_name, emit, expectedError) => {
    const input = rawInput();
    const pending = readSensitiveLine(input as unknown as TtyReadStream, "Secret: ", output());
    emit(input);
    if (expectedError === undefined) {
      await expect(pending).resolves.toBe("secret");
    } else {
      await expect(pending).rejects.toThrow(expectedError);
    }
    expect(input.rawModes).toEqual([true, false]);
  });

  it("passes sensitive and non-sensitive modes through the shared collector", async () => {
    const calls: Array<{ readonly prompt: string; readonly sensitive: boolean | undefined }> = [];
    const terminal: TerminalPort = {
      isControllingTerminal: () => true,
      readLine: async (prompt, options) => {
        calls.push({ prompt, sensitive: options?.sensitive });
        return "answer";
      },
    };
    const request = {
      schemaVersion: "pragma.human-interaction/v1",
      kind: "request",
      missionId: "11111111-1111-4111-8111-111111111111",
      executionId: "22222222-2222-4222-8222-222222222222",
      interactionId: "interaction-1",
      sensitive: true,
      interaction: {
        kind: "question",
        questions: [{ header: "Answer", question: "Secret?", kind: "text", options: [] }],
      },
    } satisfies HumanInteractionRequestEnvelope;

    await expect(collectHumanInteraction(terminal, request)).resolves.toMatchObject({
      interaction: { answers: { "Secret?": "answer" } },
    });
    expect(calls).toEqual([{ prompt: "Secret? ", sensitive: true }]);
  });
});
