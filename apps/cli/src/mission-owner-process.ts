import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  CliOwnerFrameSchema,
  CliOwnerRequestSchema,
  createIntegrationError,
  type CliOwnerFrame,
} from "@pragma/shared/integration";
import { asJsonValue } from "./commands/utils.ts";
import type { CliRunPresentationOutcome } from "./presenters/index.ts";

export type OwnerReceipt = {
  missionId: string;
  executionId?: string | undefined;
  operationId?: string | undefined;
  operationState?: string | undefined;
};
export function waitExpiredOutcome(receipt: OwnerReceipt): CliRunPresentationOutcome {
  return {
    status: "accepted",
    ...receipt,
    result: asJsonValue({
      ...receipt,
      waitExpired: true,
      missionContinues: true,
      observedStatus: "unknown",
      next: {
        get: `pragma mission get ${receipt.missionId}`,
        watch: `pragma mission watch ${receipt.missionId}`,
      },
    }),
  };
}

export async function invokeMissionOwner(input: {
  argv: readonly string[];
  requestId: string;
  stdin?: Uint8Array | undefined;
  waitTimeoutSeconds?: number | undefined;
  detach: boolean;
  ackTimeoutSeconds?: number | undefined;
  onEvent?: ((event: unknown) => void) | undefined;
  onStarted?: ((receipt: OwnerReceipt) => void) | undefined;
  onInterrupt?: ((callback: () => void) => () => void) | undefined;
  workerPath?: string | undefined;
  execArgv?: string[] | undefined;
}): Promise<CliRunPresentationOutcome> {
  const parsed = CliOwnerRequestSchema.safeParse({
    schemaVersion: "pragma.cli-owner-request/v1",
    argv: [...input.argv],
    requestId: input.requestId,
    ...(input.stdin === undefined ? {} : { stdin: Buffer.from(input.stdin).toString("base64") }),
  });
  if (!parsed.success)
    throw createIntegrationError({
      code: "INVALID_ARGUMENT",
      category: "usage",
      message: "Invalid Mission owner request or input exceeds the transport limit.",
    });
  const request = parsed.data;
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const workerPath =
    input.workerPath ??
    fileURLToPath(new URL(`./mission-owner-worker.${extension}`, import.meta.url));
  const child = fork(workerPath, [], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    execArgv:
      input.execArgv ??
      (extension === "ts"
        ? ["--import", import.meta.resolve("tsx"), "--conditions=pragma-source"]
        : []),
    env: {
      ...process.env,
      ...(process.versions.electron === undefined ? {} : { ELECTRON_RUN_AS_NODE: "1" }),
    },
  });
  return await new Promise((resolve, reject) => {
    let completed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let receipt: OwnerReceipt | undefined;
    const finish = (outcome?: CliRunPresentationOutcome, error?: unknown) => {
      if (completed) return;
      completed = true;
      clearTimeout(ackTimer);
      if (timer !== undefined) clearTimeout(timer);
      removeInterrupt?.();
      if (child.connected) child.disconnect();
      child.unref();
      if (error !== undefined) reject(error);
      else resolve(outcome!);
    };
    const ackTimer = setTimeout(
      () =>
        finish(
          undefined,
          createIntegrationError({
            code: "COMMAND_ACCEPTANCE_TIMEOUT",
            category: "conflict",
            message:
              "Owner acknowledgement timed out. Retry with the same --request-id; the request may still become durable.",
          }),
        ),
      (input.ackTimeoutSeconds ?? 30) * 1000,
    );
    const removeInterrupt = input.onInterrupt?.(() => {
      if (child.connected) child.send({ type: "cancel", requestId: input.requestId });
    });
    child.on("message", (value) => {
      if (completed) return;
      const parsed = CliOwnerFrameSchema.safeParse(value);
      if (!parsed.success) {
        finish(
          undefined,
          createIntegrationError({
            code: "PROTOCOL_VERSION_UNSUPPORTED",
            category: "protocol",
            message: "Invalid Mission owner response.",
          }),
        );
        return;
      }
      const frame: CliOwnerFrame = parsed.data;
      if (frame.type === "started") {
        clearTimeout(ackTimer);
        receipt = {
          missionId: frame.missionId,
          ...(frame.operationId === undefined ? {} : { operationId: frame.operationId }),
          ...(frame.operationState === undefined ? {} : { operationState: frame.operationState }),
          ...(frame.executionId === undefined ? {} : { executionId: frame.executionId }),
        };
        try {
          input.onStarted?.(receipt);
        } catch (error) {
          finish(undefined, error);
          return;
        }
        if (input.detach) {
          finish({
            status: "accepted",
            ...receipt,
            result: asJsonValue({ ...receipt, missionContinues: true }),
          });
          return;
        }
        if (input.waitTimeoutSeconds !== undefined)
          timer = setTimeout(
            () => finish(waitExpiredOutcome(receipt!)),
            input.waitTimeoutSeconds * 1000,
          );
      } else if (frame.type === "event") {
        try {
          input.onEvent?.(frame.event);
        } catch (error) {
          finish(undefined, error);
        }
      } else if (frame.type === "failed") finish(undefined, frame.error);
      else finish(frame.outcome);
    });
    child.once("error", (error) => finish(undefined, error));
    child.once("exit", () => {
      if (!completed)
        finish(
          undefined,
          createIntegrationError({
            code: "DEPENDENCY_UNAVAILABLE",
            category: "dependency",
            message:
              "Mission owner exited before a final response. Query the Mission and retry with the same request ID.",
          }),
        );
    });
    child.send(request, (error) => {
      if (error) finish(undefined, error);
    });
  });
}

/** Embedded Hosts retain ownership when their caller stops waiting. */
export async function waitForOwnedOutcome<T>(
  operation: Promise<T>,
  receipt: Promise<OwnerReceipt>,
  timeoutSeconds?: number,
): Promise<T | { waitExpired: true; receipt: OwnerReceipt }> {
  if (timeoutSeconds === undefined) return await operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let ended = false;
  try {
    return await Promise.race([
      operation,
      receipt.then(
        (receipt) =>
          new Promise<{ waitExpired: true; receipt: OwnerReceipt }>((resolve) => {
            if (ended) return;
            timer = setTimeout(
              () => resolve({ waitExpired: true, receipt }),
              timeoutSeconds * 1000,
            );
          }),
      ),
    ]);
  } finally {
    ended = true;
    if (timer !== undefined) clearTimeout(timer);
  }
}
