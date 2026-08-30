import { createHash } from "node:crypto";

import type { JsonValue } from "@pragma/shared/integration";

import type { LocalHostRunEvent, LocalHostRunMissionPort, LocalHostRunTerminal } from "./run.ts";
import { createRunRedactor, type RunRedactor } from "./redaction.ts";

export interface LocalHostMissionEventProjector {
  /** Queue a Core event for ordered Mission projection. */
  enqueue(event: LocalHostRunEvent): void;
  /** Append one event after all queued events have committed. */
  append(event: LocalHostRunEvent): Promise<void>;
  /** Wait for all queued events and rethrow the first projection failure. */
  flush(): Promise<void>;
  /** Append the idempotent Mission terminal event and return its redacted value. */
  appendTerminal(terminal: LocalHostRunTerminal): Promise<LocalHostRunTerminal>;
}

export function createLocalHostMissionEventProjector(options: {
  readonly missionId: string;
  readonly guard: Parameters<LocalHostRunMissionPort["append"]>[1];
  readonly mission: Pick<LocalHostRunMissionPort, "controller" | "append">;
  readonly redactor?: RunRedactor | undefined;
  readonly onEvent?: ((event: LocalHostRunEvent) => void) | undefined;
  readonly knownEventIds?: Iterable<string> | undefined;
}): LocalHostMissionEventProjector {
  const redactor = options.redactor ?? createRunRedactor();
  const knownEventIds = new Set(options.knownEventIds ?? []);
  let queued = Promise.resolve();
  let failed = false;
  let failure: unknown;

  const appendOne = async (event: LocalHostRunEvent, publish: boolean): Promise<void> => {
    const redacted = redactEvent(event, redactor);
    if (!isObjectData(event.data)) {
      if (publish) {
        options.onEvent?.({ ...redacted, replayable: false, cursor: undefined });
      }
      return;
    }

    if (event.eventId !== undefined && knownEventIds.has(event.eventId)) return;
    if (event.eventId !== undefined) {
      const snapshot = await options.mission.controller.readSnapshot({
        missionId: options.missionId,
      });
      if (snapshot.events.some((candidate) => candidate.eventId === event.eventId)) {
        knownEventIds.add(event.eventId);
        return;
      }
    }

    const committed = await options.mission.append(
      options.missionId,
      options.guard,
      event.type,
      redactEventData(event.data, redactor),
      event.eventId,
    );
    if (event.eventId !== undefined) knownEventIds.add(event.eventId);
    if (publish) {
      options.onEvent?.({ ...redacted, replayable: true, cursor: committed.cursor });
    }
  };

  const flush = async (): Promise<void> => {
    await queued;
    if (failed) throw failure;
  };

  return {
    enqueue(event) {
      queued = queued
        .then(async () => await appendOne(event, true))
        .catch((error: unknown) => {
          failed ||= true;
          failure ??= error;
        });
    },
    async append(event) {
      await flush();
      await appendOne(event, false);
    },
    flush,
    async appendTerminal(terminal) {
      await flush();
      const redacted = redactTerminal(terminal, redactor);
      const type = `run.${redacted.status}`;
      const snapshot = await options.mission.controller.readSnapshot({
        missionId: options.missionId,
      });
      if (
        snapshot.events.some(
          (event) => event.type === type && event.data["executionId"] === redacted.executionId,
        )
      ) {
        return redacted;
      }
      await appendOne(
        {
          type,
          data: terminalData(redacted),
          eventId: terminalEventId(redacted.executionId, type),
        },
        false,
      );
      return redacted;
    },
  };
}

function isObjectData(value: JsonValue): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function redactEvent(event: LocalHostRunEvent, redactor: RunRedactor): LocalHostRunEvent {
  return { ...event, data: redactor.redactJson(event.data) };
}

function redactEventData(value: JsonValue, redactor: RunRedactor): Record<string, unknown> {
  return redactor.redactJson(value) as Record<string, unknown>;
}

function redactTerminal(
  terminal: LocalHostRunTerminal,
  redactor: RunRedactor,
): LocalHostRunTerminal {
  return {
    ...terminal,
    ...(terminal.result === undefined ? {} : { result: redactor.redactJson(terminal.result) }),
    ...(terminal.interaction === undefined
      ? {}
      : { interaction: redactInteraction(terminal.interaction, redactor) }),
    ...(terminal.error === undefined
      ? {}
      : {
          error: {
            ...terminal.error,
            message: redactor.redactText(terminal.error.message),
            ...(terminal.error.details === undefined
              ? {}
              : {
                  details: redactor.redactJson(terminal.error.details) as Record<string, JsonValue>,
                }),
          },
        }),
  };
}

function terminalData(terminal: LocalHostRunTerminal): JsonValue {
  return {
    executionId: terminal.executionId,
    ...(terminal.result === undefined ? {} : { result: terminal.result }),
    ...(terminal.interaction === undefined ? {} : { interaction: terminal.interaction }),
    ...(terminal.usage === undefined ? {} : { usage: terminal.usage }),
    ...(terminal.error === undefined ? {} : { error: terminal.error }),
  } as unknown as JsonValue;
}

function terminalEventId(executionId: string, type: string): string {
  const hex = createHash("sha256")
    .update(`pragma.local-host/mission-terminal\0${executionId}\0${type}`)
    .digest("hex")
    .slice(0, 32);
  const chars = hex.split("");
  chars[12] = "5";
  chars[16] = ["8", "9", "a", "b"][Number.parseInt(chars[16] ?? "8", 16) % 4] ?? "8";
  return `${chars.slice(0, 8).join("")}-${chars.slice(8, 12).join("")}-${chars
    .slice(12, 16)
    .join("")}-${chars.slice(16, 20).join("")}-${chars.slice(20, 32).join("")}`;
}

export function redactInteraction(
  interaction: NonNullable<LocalHostRunTerminal["interaction"]>,
  redactor: RunRedactor,
): NonNullable<LocalHostRunTerminal["interaction"]> {
  return {
    ...interaction,
    interaction: redactor.redactJson(
      interaction.interaction as unknown as JsonValue,
    ) as NonNullable<LocalHostRunTerminal["interaction"]>["interaction"],
  };
}
