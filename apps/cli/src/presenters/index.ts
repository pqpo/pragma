import {
  CliEventV2Schema,
  CliResultV2Schema,
  CliStreamEndDataV2Schema,
  integrationErrorExitCode,
  type IntegrationError,
  type JsonValue,
} from "@pragma/local-host/wire";
import type { AgentMessageUsage } from "@pragma/shared";
import {
  EventIdSchema,
  type ExecutorReference,
  type WorkspaceSelection,
} from "@pragma/shared/integration";

import { HELP_TEXT, type OutputFormat } from "../parser/argv.ts";
import { isRecord } from "../commands/utils.ts";

export type CliIo = Readonly<{
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
  readonly flushStdout?: (() => void) | undefined;
}>;

export interface PresentationInput {
  readonly io: CliIo;
  readonly format: OutputFormat;
  readonly requestId: string;
  readonly command: string;
  readonly cliVersion: string;
  readonly startedAt: Date;
}

export type CliRunPresentationOutcome =
  | {
      readonly status: "accepted" | "succeeded";
      readonly missionId?: string | undefined;
      readonly executionId?: string | undefined;
      readonly executor?: ExecutorReference | undefined;
      readonly workspace?: WorkspaceSelection | undefined;
      readonly result: JsonValue;
      readonly usage?: AgentMessageUsage | undefined;
      readonly warnings?: readonly unknown[] | undefined;
      readonly lastCursor?: string | undefined;
    }
  | {
      readonly status: "input_required" | "failed" | "interrupted";
      readonly missionId?: string | undefined;
      readonly executionId?: string | undefined;
      readonly executor?: ExecutorReference | undefined;
      readonly workspace?: WorkspaceSelection | undefined;
      readonly interaction?: unknown | undefined;
      readonly error?: IntegrationError | undefined;
      readonly usage?: AgentMessageUsage | undefined;
      readonly warnings?: readonly unknown[] | undefined;
      readonly lastCursor?: string | undefined;
    };

export interface CliV2StreamPresenter {
  readonly emit: (event: {
    readonly type: string;
    readonly data: JsonValue;
    readonly missionId?: string | undefined;
    readonly executionId?: string | undefined;
    /** Durable event IDs are forwarded; synthetic events receive a new ID. */
    readonly eventId?: string | undefined;
    readonly replayable?: boolean | undefined;
    readonly cursor?: string | undefined;
    /** Durable Mission timestamps are forwarded as the CLI emittedAt value. */
    readonly emittedAt?: string | undefined;
  }) => void;
  readonly finalize: (outcome: CliRunPresentationOutcome) => void;
}

export function presentRunOutcome(
  input: PresentationInput,
  outcome: CliRunPresentationOutcome,
): void {
  if (input.format === "text") {
    input.io.writeStdout(renderRunText(outcome));
    return;
  }
  if (input.format === "json") {
    input.io.writeStdout(`${JSON.stringify(makeV2Result(input, outcome))}\n`);
    return;
  }
  const presenter = createV2StreamPresenter(input);
  presenter.finalize(outcome);
}

export function presentRunFailure(input: PresentationInput, error: IntegrationError): void {
  const outcome: CliRunPresentationOutcome = {
    status: "failed",
    error,
  };
  if (input.format === "text") {
    input.io.writeStderr(renderFailure(error));
    return;
  }
  if (input.format === "json") {
    input.io.writeStdout(`${JSON.stringify(makeV2Result(input, outcome))}\n`);
    return;
  }
  createV2StreamPresenter(input).finalize(outcome);
}

export function createV2StreamPresenter(input: PresentationInput): CliV2StreamPresenter {
  let sequence = 0;
  let finalized = false;
  let lastCursor: string | undefined;
  const write = (event: {
    readonly type: string;
    readonly data: JsonValue;
    readonly missionId?: string | undefined;
    readonly executionId?: string | undefined;
    readonly eventId?: string | undefined;
    readonly replayable?: boolean | undefined;
    readonly cursor?: string | undefined;
    readonly emittedAt?: string | undefined;
  }): void => {
    if (finalized) return;
    if (event.cursor !== undefined) lastCursor = event.cursor;
    const parsed = CliEventV2Schema.parse({
      schemaVersion: "pragma.cli-event/v2",
      requestId: input.requestId,
      eventId: durableOrSyntheticEventId(event.eventId),
      sequence: sequence++,
      emittedAt: event.emittedAt ?? new Date().toISOString(),
      replayable: event.replayable ?? false,
      ...(event.missionId === undefined ? {} : { missionId: event.missionId }),
      ...(event.executionId === undefined ? {} : { executionId: event.executionId }),
      ...(event.cursor === undefined ? {} : { cursor: event.cursor }),
      type: event.type,
      data: event.data,
    });
    input.io.writeStdout(`${JSON.stringify(parsed)}\n`);
    input.io.flushStdout?.();
  };
  return {
    emit: write,
    finalize(outcome) {
      if (finalized) return;
      const end = CliStreamEndDataV2Schema.parse({
        status: outcome.status,
        exitCode: runOutcomeExitCode(outcome),
        missionId: outcome.missionId,
        executionId: outcome.executionId,
        executor: outcome.executor,
        workspace: outcome.workspace,
        ...((outcome.lastCursor ?? lastCursor) === undefined
          ? {}
          : { lastCursor: outcome.lastCursor ?? lastCursor }),
        ...(outcome.status === "accepted" || outcome.status === "succeeded"
          ? { result: outcome.result }
          : {}),
        ...(outcome.status === "input_required" && outcome.interaction === undefined
          ? {}
          : outcome.status === "input_required"
            ? { interaction: outcome.interaction }
            : {}),
        ...(outcome.status === "failed" && outcome.error === undefined
          ? {}
          : outcome.status === "failed"
            ? { error: outcome.error }
            : {}),
        ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
        ...(outcome.warnings === undefined ? {} : { warnings: outcome.warnings }),
      });
      finalized = true;
      const parsed = {
        schemaVersion: "pragma.cli-event/v2" as const,
        requestId: input.requestId,
        eventId: globalThis.crypto.randomUUID(),
        sequence: sequence++,
        emittedAt: new Date().toISOString(),
        replayable: false,
        type: "stream.end" as const,
        data: end,
      };
      input.io.writeStdout(`${JSON.stringify(parsed)}\n`);
      input.io.flushStdout?.();
    },
  };
}

function durableOrSyntheticEventId(eventId: string | undefined): string {
  return eventId !== undefined && EventIdSchema.safeParse(eventId).success
    ? eventId
    : globalThis.crypto.randomUUID();
}

function makeV2Result(input: PresentationInput, outcome: CliRunPresentationOutcome) {
  return CliResultV2Schema.parse({
    schemaVersion: "pragma.cli-result/v2",
    requestId: input.requestId,
    command: input.command,
    status: outcome.status,
    ...(outcome.missionId === undefined ? {} : { missionId: outcome.missionId }),
    ...(outcome.executionId === undefined ? {} : { executionId: outcome.executionId }),
    ...(outcome.executor === undefined ? {} : { executor: outcome.executor }),
    ...(outcome.workspace === undefined ? {} : { workspace: outcome.workspace }),
    ...(outcome.status === "accepted" || outcome.status === "succeeded"
      ? { result: outcome.result }
      : {}),
    ...(outcome.status === "input_required" && outcome.interaction === undefined
      ? {}
      : outcome.status === "input_required"
        ? { interaction: outcome.interaction }
        : {}),
    ...(outcome.status === "failed" && outcome.error === undefined
      ? {}
      : outcome.status === "failed"
        ? { error: outcome.error }
        : {}),
    warnings: outcome.warnings ?? [],
    ...(outcome.usage === undefined ? {} : { usage: outcome.usage }),
    meta: {
      startedAt: input.startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      durationMs: Math.max(0, Date.now() - input.startedAt.getTime()),
      cliVersion: input.cliVersion,
      protocolVersion: "pragma.integration/v2",
    },
  });
}

function runOutcomeExitCode(outcome: CliRunPresentationOutcome): number {
  if (outcome.status === "accepted" || outcome.status === "succeeded") return 0;
  if (outcome.status === "input_required") return 3;
  if (outcome.status === "interrupted") return 130;
  if (outcome.status === "failed") {
    return integrationErrorExitCode(outcome.error?.code ?? "INTERNAL_ERROR");
  }
  return 10;
}

function renderRunText(outcome: CliRunPresentationOutcome): string {
  if (outcome.status === "failed") return renderFailure(outcome.error!);
  if (outcome.status === "input_required") {
    return `Input required for ${outcome.missionId}/${outcome.executionId}. Use mission respond with the pending interaction.\n`;
  }
  if (outcome.status === "interrupted") return `Interrupted: ${outcome.executionId}\n`;
  if (outcome.status === "accepted") {
    return `Accepted: mission ${outcome.missionId}, execution ${outcome.executionId}\n`;
  }
  if (outcome.status === "succeeded") return `${JSON.stringify(outcome.result, null, 2)}\n`;
  return "\n";
}

export function presentSuccess(input: PresentationInput, result: JsonValue): void {
  if (input.format === "text") {
    input.io.writeStdout(renderText(input.command, result));
    return;
  }
  if (input.format === "json") {
    input.io.writeStdout(
      `${JSON.stringify(makeV2Result(input, { status: "succeeded", result }))}\n`,
    );
    return;
  }
  const presenter = createV2StreamPresenter(input);
  presenter.emit({ type: "command.result", data: { command: input.command, result } });
  presenter.finalize({ status: "succeeded", result });
}

export function renderWatchEventText(event: {
  readonly type: string;
  readonly data: JsonValue;
  readonly cursor?: string | undefined;
}): string {
  const data = isRecord(event.data) ? event.data : undefined;
  if (event.type === "mission.snapshot") {
    const missionId = typeof data?.["missionId"] === "string" ? data["missionId"] : "unknown";
    const status = typeof data?.["status"] === "string" ? data["status"] : "unknown";
    const cursor = event.cursor ?? (typeof data?.["cursor"] === "string" ? data["cursor"] : "");
    return `Mission ${missionId}: ${status}${cursor === "" ? "" : ` (cursor ${cursor})`}\n`;
  }
  if (event.type === "watch.ready") {
    const missionId = typeof data?.["missionId"] === "string" ? data["missionId"] : "unknown";
    return `Watching Mission ${missionId}.\n`;
  }
  if (event.type === "watch.detached") {
    const cursor = typeof data?.["lastCursor"] === "string" ? data["lastCursor"] : undefined;
    return `Detached; Mission continues.${cursor === undefined ? "" : ` cursor=${cursor}`}\n`;
  }
  return `${event.type}: ${JSON.stringify(event.data)}\n`;
}

export function presentAccepted(input: PresentationInput, result: JsonValue): void {
  if (input.format === "text") {
    input.io.writeStdout(`Accepted: ${JSON.stringify(result)}\n`);
    return;
  }
  if (input.format === "json") {
    input.io.writeStdout(
      `${JSON.stringify(makeV2Result(input, { status: "accepted", result }))}\n`,
    );
    return;
  }
  const presenter = createV2StreamPresenter(input);
  presenter.emit({ type: "command.result", data: { command: input.command, result } });
  presenter.finalize({ status: "accepted", result });
}

export function presentInputRequired(input: PresentationInput, result: JsonValue): void {
  const record = isRecord(result) ? result : undefined;
  const operation =
    record !== undefined && isRecord(record["operation"]) ? record["operation"] : undefined;
  const execution =
    record !== undefined && isRecord(record["execution"]) ? record["execution"] : undefined;
  const interaction = execution?.["interaction"] ?? record?.["interaction"];
  const missionId =
    typeof operation?.["missionId"] === "string"
      ? operation["missionId"]
      : typeof record?.["missionId"] === "string"
        ? record["missionId"]
        : undefined;
  if (missionId === undefined || execution === undefined || interaction === undefined) {
    presentFailure(input, {
      code: "COMMAND_REJECTED",
      schemaVersion: "pragma.integration-error/v1",
      category: "conflict",
      message: "The Mission reported pending input without an interaction envelope.",
      retryable: false,
    });
    return;
  }
  presentRunOutcome(input, {
    status: "input_required",
    missionId,
    ...(typeof execution["executionId"] === "string"
      ? { executionId: execution["executionId"] }
      : {}),
    interaction,
  });
}

export function presentFailure(
  input: PresentationInput,
  error: IntegrationError,
  options: Readonly<{ readonly textToStdout?: boolean }> = {},
): void {
  if (input.format !== "text") {
    presentRunFailure(input, error);
    return;
  }
  const text = renderFailure(error);
  if (options.textToStdout === true) input.io.writeStdout(text);
  else input.io.writeStderr(text);
}

function renderText(command: string, result: JsonValue): string {
  if (command === "help") return String(resultValue(result, "help") ?? HELP_TEXT);
  if (command === "completion" && isRecord(result)) {
    const script = result["script"];
    if (typeof script === "string") return script;
  }
  if (command === "version" && isRecord(result)) return renderVersion(result);
  if (command === "doctor" && isRecord(result)) {
    const credentials = result["credentials"];
    if (Array.isArray(credentials)) return renderCredentialFindings(credentials);
  }
  if (command === "mission.board.read" && isRecord(result)) {
    const item = result["item"];
    if (isRecord(item) && typeof item["content"] === "string") return item["content"];
  }
  if (isRecord(result) && Array.isArray(result["items"])) return renderList(result["items"]);
  if (command === "mission.board.search" && isRecord(result) && Array.isArray(result["matches"])) {
    return renderBoardSearch(result["matches"]);
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

function renderVersion(result: Record<string, unknown>): string {
  const version = typeof result["cliVersion"] === "string" ? result["cliVersion"] : "unknown";
  const desktop =
    typeof result["desktopBundleVersion"] === "string" ? result["desktopBundleVersion"] : "unknown";
  const wire = typeof result["wireVersion"] === "string" ? result["wireVersion"] : "unknown";
  const storage =
    typeof result["storageMajor"] === "number" ? String(result["storageMajor"]) : "unknown";
  const installSource =
    typeof result["installSource"] === "string" ? result["installSource"] : "unknown";
  const platform = typeof result["platform"] === "string" ? result["platform"] : "unknown";
  const arch = typeof result["arch"] === "string" ? result["arch"] : "unknown";
  return `pragma ${version}\ndesktop: ${desktop}\nwire: ${wire}\nstorage: ${storage}\ninstall: ${installSource}\nplatform: ${platform}/${arch}\n`;
}

function renderList(items: readonly JsonValue[]): string {
  if (items.length === 0) return "No items found.\n";
  return (
    items
      .map((item) => {
        if (!isRecord(item)) return JSON.stringify(item);
        const reference = valueText(item, "ref") ?? valueText(item, "id");
        const name = valueText(item, "name") ?? valueText(item, "title");
        const status = valueText(item, "status") ?? valueText(item, "lifecycleStatus");
        return [reference, name, status]
          .filter((value): value is string => value !== undefined)
          .join("\t");
      })
      .join("\n") + "\n"
  );
}

function renderBoardSearch(matches: readonly JsonValue[]): string {
  if (matches.length === 0) return "No matches found.\n";
  return (
    matches
      .map((match) => {
        if (!isRecord(match)) return JSON.stringify(match);
        const item = isRecord(match["item"]) ? match["item"] : undefined;
        const itemId = item === undefined ? undefined : valueText(item, "id");
        const line = valueText(match, "line") ?? "?";
        const snippet = typeof match["snippet"] === "string" ? match["snippet"] : "";
        return `${itemId ?? "unknown"}:${line}\t${snippet}`;
      })
      .join("\n") + "\n"
  );
}

function renderCredentialFindings(items: readonly JsonValue[]): string {
  if (items.length === 0) return "Credential diagnostics: ready\n";
  return (
    items
      .map((item) => {
        if (!isRecord(item)) return JSON.stringify(item);
        const module = valueText(item, "module") ?? "unknown";
        const status = valueText(item, "status") ?? "unknown";
        const code = valueText(item, "code");
        return `${module}: ${status}${code === undefined ? "" : ` (${code})`}`;
      })
      .join("\n") + "\n"
  );
}

function renderFailure(error: IntegrationError): string {
  const credentials = error.details?.["credentials"];
  return `${Array.isArray(credentials) ? renderCredentialFindings(credentials) : ""}${error.code}: ${error.message}\n`;
}

function resultValue(value: JsonValue, key: string): JsonValue | undefined {
  return isRecord(value) ? value[key] : undefined;
}

function valueText(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" || typeof field === "number" ? String(field) : undefined;
}
