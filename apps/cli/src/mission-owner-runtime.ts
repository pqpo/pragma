import {
  CliOwnerRequestSchema,
  CliOwnerFrameSchema,
  RunOutcomeSchema,
  CliOwnerCancelSchema,
  createIntegrationError,
  type CliOwnerFrame,
} from "@pragma/shared/integration";
import type { CliLocalHost } from "./commands/types.ts";
import { parseCliArgv, CliParseError } from "./parser/argv.ts";
import { createSystemTerminalPort } from "./terminal.ts";
import { startExecutorRun } from "./commands/run.ts";
import { executeMutationCommand } from "./commands/mutations.ts";
import { normalizeRunOutcome } from "./index.ts";
import { toIntegrationError } from "./commands/errors.ts";
import { CLI_VERSION } from "./version.ts";
import { asJsonValue, isRecord } from "./commands/utils.ts";

/** Only process composition: execution, leases and durability remain in Local Host. */
export async function runMissionOwnerRequest(
  value: unknown,
  createHost: () => CliLocalHost,
  send: (frame: CliOwnerFrame) => Promise<void>,
): Promise<void> {
  let host: CliLocalHost | undefined;
  let requestId: string | undefined;
  const keepAlive = setInterval(() => undefined, 1000);
  let cancel: (() => Promise<void>) | undefined;
  let cancelRequested = false;
  const onMessage = (value: unknown) => {
    const message = CliOwnerCancelSchema.safeParse(value);
    if (!message.success || message.data.requestId !== requestId) return;
    cancelRequested = true;
    void cancel?.().catch(() => undefined);
  };
  process.on("message", onMessage);
  try {
    const validated = CliOwnerRequestSchema.safeParse(value);
    if (!validated.success)
      throw createIntegrationError({
        code: "INVALID_ARGUMENT",
        category: "usage",
        message: "Invalid Mission owner request.",
      });
    const request = validated.data;
    requestId = request.requestId;
    const parsed = parseCliArgv(request.argv);
    host = createHost();
    const context = {
      requestId: request.requestId,
      cliVersion: CLI_VERSION,
      startedAt: new Date(),
      localHost: host,
      format: parsed.options.format,
      outputView: parsed.options.outputView,
      interactive: "never" as const,
      terminal: createSystemTerminalPort(),
    };
    const readStdin = async () => Buffer.from(request.stdin ?? "", "base64");
    if (parsed.command.kind === "executor-run") {
      const handle = await startExecutorRun({ ...parsed.command, detach: false }, context, {
        readStdin,
        onHumanInteraction: async () => ({ kind: "checkpoint" }),
        onEvent: (event) => {
          void send({ type: "event", event: asJsonValue(event) }).catch(() => undefined);
        },
      });
      cancel = async () => handle.cancel("SIGINT");
      if (cancelRequested) await cancel();
      await send({
        type: "started",
        missionId: handle.missionId,
        ...(handle.executionId === undefined ? {} : { executionId: handle.executionId }),
      });
      const outcome = normalizeRunOutcome(await handle.outcome, handle.request);
      await host.dispose?.();
      await send({ type: "completed", outcome: RunOutcomeSchema.parse(outcome) });
    } else if (
      [
        "mission-send",
        "mission-steer",
        "mission-respond",
        "mission-interrupt",
        "queue-steer",
      ].includes(parsed.command.kind)
    ) {
      const command = parsed.command as Extract<
        typeof parsed.command,
        {
          kind:
            | "mission-send"
            | "mission-steer"
            | "mission-respond"
            | "mission-interrupt"
            | "queue-steer";
        }
      >;
      const result = await executeMutationCommand(
        { ...command, detach: false, wait: true },
        context,
        readStdin,
        (receipt) => {
          void send({ type: "started", ...receipt }).catch(() => undefined);
        },
      );
      await host.dispose?.();
      const execution =
        isRecord(result.result) && isRecord(result.result["execution"])
          ? result.result["execution"]
          : {};
      const executionIdentity =
        typeof execution["executionId"] === "string"
          ? { executionId: execution["executionId"] }
          : {};
      if (result.status === "input_required" && isRecord(result.result)) {
        await send({
          type: "completed",
          outcome: RunOutcomeSchema.parse({
            status: "input_required",
            missionId: command.missionId,
            ...executionIdentity,
            interaction: execution["interaction"],
          }),
        });
      } else
        await send({
          type: "completed",
          outcome: {
            status: "succeeded",
            missionId: command.missionId,
            ...executionIdentity,
            result: result.result,
            warnings: [],
          },
        });
    } else throw new Error("Unsupported Mission owner command.");
  } catch (error) {
    await host?.dispose?.().catch(() => undefined);
    await send({
      type: "failed",
      error: toIntegrationError(error instanceof CliParseError ? error.error : error),
    });
  } finally {
    process.removeListener("message", onMessage);
    clearInterval(keepAlive);
  }
}

/** Shared bundle entry used by the tiny packaged owner bootstrap. */
export async function runMissionOwnerProcessMessage(value: unknown): Promise<void> {
  const { createProductionLocalHost } = await import("./composition/default.ts");
  await runMissionOwnerRequest(value, createProductionLocalHost, async (frame) => {
    const parsed = CliOwnerFrameSchema.parse(frame);
    if (!process.connected) return;
    await new Promise<void>((resolve) => {
      try {
        process.send?.(parsed, () => resolve());
      } catch {
        resolve();
      }
    });
  });
}
