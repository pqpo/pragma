import {
  normalizeMissionPrompt,
  type MissionControlApplication,
  type MissionControlExecutionOutcome,
} from "@pragma/local-host";
import {
  createIntegrationError,
  IntegrationErrorSchema,
  HumanInteractionRequestEnvelopeSchema,
  type JsonValue,
  type MissionCommand,
} from "@pragma/shared/integration";
import { HumanInteractionResponseSchema } from "@pragma/shared";

import { readBoundedJson, readBoundedUtf8 } from "../input.ts";
import type { ParsedCommand } from "../parser/argv.ts";
import { collectHumanInteraction } from "../terminal.ts";
import type { CliCommandContext } from "./types.ts";
import { asJsonValue } from "./utils.ts";

type MutationCommand = Extract<
  ParsedCommand,
  {
    readonly kind:
      | "mission-send"
      | "mission-steer"
      | "mission-respond"
      | "mission-interrupt"
      | "queue-remove"
      | "queue-resume"
      | "queue-steer";
  }
>;

/** Executes the seven durable Inbox commands through the shared Host port. */
export async function executeMutationCommand(
  command: MutationCommand,
  context: CliCommandContext,
  readStdin?: (() => Promise<Uint8Array>) | undefined,
): Promise<{
  readonly result: JsonValue;
  readonly detached: boolean;
  readonly status?: "input_required" | undefined;
}> {
  const control = context.localHost.missionControl;
  if (control === undefined) {
    throw createIntegrationError({
      code: "DEPENDENCY_UNAVAILABLE",
      category: "dependency",
      message: "Mission mutation commands are unavailable in this Host composition.",
    });
  }
  if (context.interactive === "always" && !context.terminal.isControllingTerminal()) {
    throw createIntegrationError({
      code: "INTERACTIVE_TTY_REQUIRED",
      category: "usage",
      message: "--interactive always requires a controlling terminal.",
    });
  }
  const requestId = command.requestId ?? context.requestId;
  const submission = await control.submit(
    await createSubmissionInput(command, requestId, readStdin),
  );
  if (isTerminalOperation(submission.operation.state) && submission.operation.state !== "applied") {
    assertOperationSucceeded(submission.operation);
  }
  if ("detach" in command && command.detach) {
    // submit() is the durability barrier. Detached callers must not wait for
    // an owner to acquire the Mission lease; a queued operation is a valid
    // successful receipt and can be observed later through mission watch/query.
    return { result: asJsonValue(submission.operation), detached: true };
  }
  const accepted = await control.waitForAcceptance({
    missionId: command.missionId,
    requestId,
    timeoutMs: command.ackTimeoutSeconds * 1_000,
  });
  if (isTerminalOperation(accepted.state) && accepted.state !== "applied") {
    assertOperationSucceeded(accepted);
  }
  const operation = isTerminalOperation(accepted.state)
    ? accepted
    : await control.waitForTerminal({ missionId: command.missionId, requestId });
  assertOperationSucceeded(operation);
  const executionId = operation.result?.["executionId"];
  if (
    shouldWaitForExecution(command) &&
    typeof executionId === "string" &&
    control.waitExecution !== undefined &&
    operation.result?.["queueState"] !== "paused"
  ) {
    const execution = await waitForMutationExecution({
      command,
      control,
      context,
      executionId,
    });
    if (execution.status === "failed") {
      throw (
        execution.error ??
        createIntegrationError({
          code: "EXECUTION_FAILED",
          category: "execution",
          retryable: false,
          message: "The Mission execution failed.",
        })
      );
    }
    const result = asJsonValue({ missionId: command.missionId, operation, execution });
    if (execution.status === "waiting") {
      return { result, detached: false, status: "input_required" };
    }
    return { result, detached: false };
  }
  return {
    result:
      operation.result?.["queueState"] === "paused"
        ? asJsonValue({
            operation,
            warning: "QUEUE_PAUSED",
          })
        : asJsonValue(operation),
    detached: false,
  };
}

async function waitForMutationExecution(options: {
  readonly command: MutationCommand;
  readonly control: MissionControlApplication;
  readonly context: CliCommandContext;
  readonly executionId: string;
}): Promise<MissionControlExecutionOutcome> {
  for (;;) {
    const execution = await options.control.waitExecution!({
      missionId: options.command.missionId,
      executionId: options.executionId,
    });
    if (execution.status !== "waiting" || execution.interaction === undefined) return execution;
    const useTerminalInteraction =
      options.context.interactive === "always" ||
      (options.context.interactive === "auto" &&
        options.context.format === "text" &&
        options.context.terminal.isControllingTerminal());
    if (!useTerminalInteraction) return execution;
    const interaction = HumanInteractionRequestEnvelopeSchema.parse(execution.interaction);
    const response = (await collectHumanInteraction(options.context.terminal, interaction))
      .interaction;
    const responseRequestId = globalThis.crypto.randomUUID();
    await options.control.submit({
      missionId: options.command.missionId,
      requestId: responseRequestId,
      kind: "respond",
      payload: { kind: "respond", response },
      target: { interactionId: interaction.interactionId },
    });
    const acceptedResponse = await options.control.waitForAcceptance({
      missionId: options.command.missionId,
      requestId: responseRequestId,
      timeoutMs: options.command.ackTimeoutSeconds * 1_000,
    });
    const responseOperation = isTerminalOperation(acceptedResponse.state)
      ? acceptedResponse
      : await options.control.waitForTerminal({
          missionId: options.command.missionId,
          requestId: responseRequestId,
        });
    assertOperationSucceeded(responseOperation);
  }
}

function isTerminalOperation(state: string): boolean {
  return state === "applied" || state === "rejected" || state === "expired" || state === "failed";
}

async function createSubmissionInput(
  command: MutationCommand,
  requestId: string,
  readStdin: (() => Promise<Uint8Array>) | undefined,
): Promise<Parameters<MissionControlApplication["submit"]>[0]> {
  switch (command.kind) {
    case "mission-send":
    case "mission-steer": {
      const rawPrompt =
        command.prompt ??
        (command.inputPath === undefined
          ? undefined
          : await readBoundedUtf8(command.inputPath, readStdin));
      if (rawPrompt === undefined) {
        throw createIntegrationError({
          code: "INVALID_ARGUMENT",
          category: "usage",
          message: "A prompt input is required.",
        });
      }
      const prompt = normalizeMissionPrompt(rawPrompt);
      if (prompt === "") {
        throw createIntegrationError({
          code: "INVALID_ARGUMENT",
          category: "usage",
          message: "A prompt input must not be empty.",
        });
      }
      const payload = {
        kind: command.kind === "mission-send" ? ("send" as const) : ("steer" as const),
        input: { prompt, attachments: [] },
      } satisfies MissionCommand["payload"];
      return {
        missionId: command.missionId,
        requestId,
        kind: payload.kind,
        payload,
        ...(command.expectedExecutionId === undefined
          ? {}
          : { expectedExecutionId: command.expectedExecutionId }),
      };
    }
    case "mission-respond": {
      const response = await readResponse(command, readStdin);
      return {
        missionId: command.missionId,
        requestId,
        kind: "respond",
        payload: { kind: "respond", response },
        target: { interactionId: command.interactionId },
      };
    }
    case "mission-interrupt":
      return {
        missionId: command.missionId,
        requestId,
        kind: "interrupt",
        payload: {
          kind: "interrupt",
          ...(command.reason === undefined ? {} : { reason: command.reason }),
        },
        ...(command.expectedExecutionId === undefined
          ? {}
          : { expectedExecutionId: command.expectedExecutionId }),
      };
    case "queue-remove":
      return {
        missionId: command.missionId,
        requestId,
        kind: "queue.remove",
        payload: { kind: "queue.remove", requestId: command.requestIdToRemove },
        target: { queueItemId: command.requestIdToRemove },
      };
    case "queue-resume":
      return {
        missionId: command.missionId,
        requestId,
        kind: "queue.resume",
        payload: { kind: "queue.resume" },
      };
    case "queue-steer":
      return {
        missionId: command.missionId,
        requestId,
        kind: "queue.steer",
        payload: { kind: "queue.steer", requestId: command.requestIdToSteer },
        target: { queueItemId: command.requestIdToSteer },
        ...(command.expectedExecutionId === undefined
          ? {}
          : { expectedExecutionId: command.expectedExecutionId }),
      };
  }
}

async function readResponse(
  command: Extract<MutationCommand, { readonly kind: "mission-respond" }>,
  readStdin: (() => Promise<Uint8Array>) | undefined,
) {
  if (command.answer !== undefined) {
    return HumanInteractionResponseSchema.parse({ answers: command.answer });
  }
  if (command.choices !== undefined) {
    return HumanInteractionResponseSchema.parse({
      selection: command.choices.length === 1 ? command.choices[0] : command.choices,
    });
  }
  if (command.answersPath === undefined) {
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "A response input is required.",
    });
  }
  // The file is the complete response object, not an arbitrary answers map.
  // This keeps --answers-json aligned with the shared response contract and
  // allows callers to provide notes/data alongside answers when needed.
  return HumanInteractionResponseSchema.parse(
    await readBoundedJson(command.answersPath, readStdin),
  );
}

function shouldWaitForExecution(command: MutationCommand): boolean {
  return "wait" in command && command.wait;
}

function assertOperationSucceeded(operation: {
  readonly state: string;
  readonly error?: Record<string, unknown> | undefined;
}): void {
  if (operation.state === "applied") return;
  const error = IntegrationErrorSchema.safeParse(operation.error);
  if (error.success) throw error.data;
  throw createIntegrationError({
    code: operation.state === "expired" ? "COMMAND_EXPIRED" : "COMMAND_REJECTED",
    category: "conflict",
    message: "The Mission command was not applied.",
  });
}
