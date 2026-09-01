import { closeSync, constants, existsSync, openSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { stderr } from "node:process";
import { ReadStream as TtyReadStream } from "node:tty";

import type {
  HumanInteractionRequestEnvelope,
  HumanInteractionResponseEnvelope,
} from "@pragma/shared/integration";

export interface TerminalPort {
  isControllingTerminal(): boolean;
  readLine(prompt: string, options?: { readonly sensitive?: boolean | undefined }): Promise<string>;
}

/** The CLI never consumes stdin for interaction; it uses the controlling TTY. */
export function createSystemTerminalPort(
  options: { readonly output?: NodeJS.WritableStream | undefined } = {},
): TerminalPort {
  const output = options.output ?? stderr;
  return {
    isControllingTerminal: () => canOpenControllingTerminal(),
    readLine: async (prompt, options = {}) => {
      if (!canOpenControllingTerminal()) throw new Error("A controlling terminal is unavailable.");
      const terminal = openControllingTerminal();
      try {
        if (options.sensitive === true) {
          return await readSensitiveLine(terminal.input, prompt, output);
        }
        const readline = createInterface({ input: terminal.input, output, terminal: true });
        try {
          return await readline.question(prompt);
        } finally {
          readline.close();
        }
      } finally {
        terminal.close();
      }
    },
  };
}

export async function collectHumanInteraction(
  terminal: TerminalPort,
  request: HumanInteractionRequestEnvelope,
): Promise<HumanInteractionResponseEnvelope> {
  const interaction = request.interaction;
  if (interaction.kind === "approval") {
    const options = interaction.options ?? [];
    const suffix =
      options.length === 0 ? " [y/N]" : ` [${options.map((item) => item.label).join("/")}]`;
    const answer = (
      await terminal.readLine(
        `${interaction.prompt ?? interaction.title ?? "Approve?"}${suffix} `,
        {
          sensitive: request.sensitive,
        },
      )
    )
      .trim()
      .toLowerCase();
    const approved =
      answer === "y" ||
      answer === "yes" ||
      answer === "approve" ||
      answer === interaction.approveOption?.toLowerCase();
    return responseEnvelope(request, {
      approved,
      decision: answer || (approved ? "approve" : "reject"),
    });
  }

  const answers: Record<string, string | readonly string[]> = {};
  for (const question of interaction.questions ?? []) {
    const options = question.options;
    const suffix = options.length === 0 ? "" : ` [${options.map((item) => item.label).join("/")}]`;
    const answer = (
      await terminal.readLine(`${question.question}${suffix} `, {
        sensitive: request.sensitive,
      })
    ).trim();
    if (answer === "") throw new Error(`An answer is required for: ${question.question}`);
    const values = answer
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    const resolved = values.map(
      (value) =>
        options.find((option) => option.label === value || option.value === value)?.value ?? value,
    );
    answers[question.question] = question.kind === "multiple_choice" ? resolved : resolved[0]!;
  }
  if (interaction.kind === "manual_intervention" || interaction.kind === "review_gate") {
    const notes = await terminal.readLine(
      `${interaction.prompt ?? interaction.title ?? "Notes"}: `,
      {
        sensitive: request.sensitive,
      },
    );
    return responseEnvelope(request, { answers, notes });
  }
  return responseEnvelope(request, { answers });
}

function responseEnvelope(
  request: HumanInteractionRequestEnvelope,
  interaction: Record<string, unknown>,
): HumanInteractionResponseEnvelope {
  return {
    schemaVersion: "pragma.human-interaction/v1",
    kind: "response",
    missionId: request.missionId,
    executionId: request.executionId,
    interactionId: request.interactionId,
    sensitive: request.sensitive,
    interaction: interaction as HumanInteractionResponseEnvelope["interaction"],
  };
}

export function controllingTerminalPath(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "CONIN$" : "/dev/tty";
}

function canOpenControllingTerminal(): boolean {
  const path = controllingTerminalPath();
  if (!existsSync(path)) return false;
  try {
    const descriptor = openSync(path, constants.O_RDWR);
    closeSync(descriptor);
    return true;
  } catch {
    return false;
  }
}

function openControllingTerminal(): {
  readonly input: TtyReadStream;
  readonly close: () => void;
} {
  const fd = openSync(controllingTerminalPath(), constants.O_RDWR);
  try {
    const input = new TtyReadStream(fd);
    let closed = false;
    return {
      input,
      close: () => {
        if (closed) return;
        closed = true;
        input.destroy();
        try {
          closeSync(fd);
        } catch (error) {
          if (!isAlreadyClosedError(error)) throw error;
        }
      },
    };
  } catch (error) {
    closeSync(fd);
    throw error;
  }
}

function isAlreadyClosedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error.code === "EBADF" || error.code === "ERR_STREAM_DESTROYED")
  );
}

export async function readSensitiveLine(
  input: TtyReadStream,
  prompt: string,
  output: NodeJS.WritableStream = stderr,
): Promise<string> {
  output.write(prompt);
  const rawInput = input as typeof input & {
    setRawMode: (enabled: boolean) => void;
  };
  rawInput.setRawMode(true);
  input.setEncoding("utf8");
  input.resume();
  return await new Promise<string>((resolve, reject) => {
    let value = "";
    let finished = false;
    const cleanup = (): void => {
      input.removeListener("data", onData);
      input.removeListener("error", onError);
      input.removeListener("end", onClose);
      input.removeListener("close", onClose);
      input.pause();
    };
    const finish = (error?: unknown): void => {
      if (finished) return;
      finished = true;
      let restoreError: unknown;
      try {
        rawInput.setRawMode(false);
      } catch (restoreFailure) {
        restoreError = restoreFailure;
      }
      cleanup();
      output.write("\n");
      if (error !== undefined) reject(error);
      else if (restoreError !== undefined) reject(restoreError);
      else resolve(value);
    };
    const onData = (chunk: string | Buffer): void => {
      for (const character of chunk.toString()) {
        if (character === "\n" || character === "\r") {
          finish();
          return;
        }
        if (character === "\u0003") {
          finish(new Error("Terminal input interrupted."));
          return;
        }
        if (character === "\u007f") value = value.slice(0, -1);
        else value += character;
      }
    };
    const onError = (error: Error): void => finish(error);
    const onClose = (): void => finish(new Error("Controlling terminal closed."));
    input.on("data", onData);
    input.once("error", onError);
    input.once("end", onClose);
    input.once("close", onClose);
  });
}
