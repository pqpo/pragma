import {
  CliEventV2Schema,
  CliResultV2Schema,
  CliStreamEndDataV2Schema,
  EventIdSchema,
  integrationErrorExitCode,
  type CliWatchObservedStatus,
  type CliWatchStopReason,
  type ExecutorReference,
  type IntegrationError,
  type JsonValue,
  type WorkspaceSelection,
} from "@pragma/shared/integration";
import type { AgentMessageUsage } from "@pragma/shared";

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
  readonly continuationCommand?: ((cursor: string) => string) | undefined;
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
      readonly observedStatus?: CliWatchObservedStatus | undefined;
      readonly stopReason?: CliWatchStopReason | undefined;
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
      readonly observedStatus?: CliWatchObservedStatus | undefined;
      readonly stopReason?: CliWatchStopReason | undefined;
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
    input.io.writeStdout(renderRunText(outcome, input.requestId));
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
    input.io.writeStderr(renderFailure(error, input.requestId));
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
        ...(outcome.observedStatus === undefined ? {} : { observedStatus: outcome.observedStatus }),
        ...(outcome.stopReason === undefined ? {} : { stopReason: outcome.stopReason }),
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

function renderRunText(outcome: CliRunPresentationOutcome, requestId: string): string {
  if (outcome.status === "failed") return renderFailure(outcome.error!, requestId);
  if (outcome.status === "input_required") {
    return `Request ID: ${requestId}\nInput required for ${outcome.missionId ?? "unknown"}/${outcome.executionId ?? "unknown"}. Use mission respond with the pending interaction.\n`;
  }
  if (outcome.status === "interrupted") {
    return `Request ID: ${requestId}\nInterrupted: ${outcome.executionId ?? "unknown"}\n`;
  }
  if (outcome.status === "accepted") {
    return `Accepted: request ${requestId}, mission ${outcome.missionId ?? "unknown"}, execution ${outcome.executionId ?? "unknown"}\n`;
  }
  if (outcome.status === "succeeded") return `${JSON.stringify(outcome.result, null, 2)}\n`;
  return "\n";
}

export function presentSuccess(input: PresentationInput, result: JsonValue): void {
  if (input.format === "text") {
    input.io.writeStdout(renderText(input.command, result, input.continuationCommand));
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
  const executionId = valueText(data, "executionId");
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
    const observedStatus = valueText(data, "observedStatus");
    const stopReason = valueText(data, "stopReason");
    return `Detached; Mission continues.${
      observedStatus === undefined ? "" : ` observedStatus=${observedStatus};`
    }${stopReason === undefined ? "" : ` stopReason=${stopReason};`}${
      cursor === undefined ? "" : ` cursor=${cursor}`
    }\n`;
  }
  if (event.type === "mission.created") {
    return `Mission ${valueText(data, "missionId") ?? "unknown"} created.\n`;
  }
  if (event.type === "run.accepted") {
    return `Run accepted${executionId === undefined ? "" : ` for execution ${executionId}`}.\n`;
  }
  if (event.type === "run.started" || event.type === "execution.started") {
    return `Execution ${executionId ?? "unknown"} started.\n`;
  }
  if (event.type === "run.progress") {
    return `Progress${executionId === undefined ? "" : ` (${executionId})`}: ${valueText(data, "message") ?? JSON.stringify(event.data)}\n`;
  }
  if (event.type === "output.delta") {
    const delta = valueText(data, "delta") ?? valueText(data, "content") ?? "";
    return `Output${executionId === undefined ? "" : ` (${executionId})`}: ${delta}\n`;
  }
  if (event.type === "message.committed") {
    return `Message${executionId === undefined ? "" : ` (${executionId})`}: ${valueText(data, "content") ?? ""}\n`;
  }
  if (event.type === "human.interaction.requested" || event.type === "run.input_required") {
    return `Input required for execution ${executionId ?? "unknown"}; interaction ${valueText(data, "interactionId") ?? "<INTERACTION_ID>"}.\n`;
  }
  if (event.type === "human.interaction.resolved") {
    return `Human input resolved for execution ${executionId ?? "unknown"}.\n`;
  }
  if (event.type === "run.succeeded") {
    return `Execution ${executionId ?? "unknown"} succeeded.\n`;
  }
  if (event.type === "run.failed") {
    const error = recordValue(data, "error");
    return `Execution ${executionId ?? "unknown"} failed: ${valueText(error, "message") ?? "unknown error"}\n`;
  }
  if (event.type === "run.interrupted") {
    return `Execution ${executionId ?? "unknown"} interrupted.\n`;
  }
  return `${event.type}: ${JSON.stringify(event.data)}\n`;
}

export function presentAccepted(input: PresentationInput, result: JsonValue): void {
  if (input.format === "text") {
    input.io.writeStdout(renderAcceptedText(input.command, result));
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

function renderText(
  command: string,
  result: JsonValue,
  continuationCommand?: ((cursor: string) => string) | undefined,
): string {
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
  if (
    command === "executor.discover" ||
    command === "team.discover" ||
    command === "expert.discover" ||
    command === "flow.discover"
  ) {
    return renderExecutorList(command, result, continuationCommand);
  }
  if (command === "team.describe" || command === "expert.describe" || command === "flow.describe") {
    return renderExecutorDetails(result);
  }
  if (command === "mission.list") return renderMissionList(result, continuationCommand);
  if (command === "mission.get") return renderMissionView(result, continuationCommand);
  if (command === "mission.queue.list") return renderQueueList(result, continuationCommand);
  if (isMutationCommandName(command)) return renderMutationText(command, result, false);
  if (isRecord(result) && Array.isArray(result["items"])) {
    return renderList(result["items"], result, command, continuationCommand);
  }
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

function renderList(
  items: readonly JsonValue[],
  result?: JsonValue,
  command?: string,
  continuationCommand?: ((cursor: string) => string) | undefined,
): string {
  if (items.length === 0) {
    const body = "No items found.\n";
    return result === undefined || command === undefined
      ? body
      : appendContinuation(body, result, command, continuationCommand);
  }
  const body =
    items
      .map((item) => {
        if (!isRecord(item)) return JSON.stringify(item);
        const reference = referenceText(item["ref"]) ?? valueText(item, "id");
        const name = valueText(item, "name") ?? valueText(item, "title");
        const status = valueText(item, "status") ?? valueText(item, "lifecycleStatus");
        return [reference, name, status]
          .filter((value): value is string => value !== undefined)
          .join("\t");
      })
      .join("\n") + "\n";
  return result === undefined || command === undefined
    ? body
    : appendContinuation(body, result, command, continuationCommand);
}

function renderExecutorList(
  command: string,
  result: JsonValue,
  continuationCommand?: ((cursor: string) => string) | undefined,
): string {
  const items = arrayValue(result, "items");
  if (items.length === 0) {
    return appendContinuation("No executors found.\n", result, command, continuationCommand);
  }
  const lines = items.map((item) => {
    if (!isRecord(item)) return JSON.stringify(item);
    const ref = referenceText(item["ref"]) ?? "unknown";
    const name = valueText(item, "name") ?? "unnamed";
    const availability = recordValue(item, "availability");
    const status = valueText(availability, "status") ?? "unknown";
    const source = valueText(item, "source") ?? "-";
    const project = recordValue(item, "project");
    const projectText =
      project === undefined
        ? "-"
        : `${valueText(project, "projectId") ?? "?"}@${valueText(project, "revision") ?? "?"}`;
    const blockingCodes = Array.isArray(availability?.["blockingCodes"])
      ? availability["blockingCodes"].filter((code): code is string => typeof code === "string")
      : [];
    const description = [
      ...(blockingCodes.length === 0 ? [] : [`blocking: ${blockingCodes[0]}`]),
      collapseWhitespace(valueText(item, "description") ?? ""),
    ]
      .filter((value) => value !== "")
      .join("; ");
    return `${ref}\t${name}\t${status}\t${source}\t${projectText}\t${description}`;
  });
  return appendContinuation(
    `${["REF", "NAME", "STATUS", "SOURCE", "PROJECT", "DESCRIPTION"].join("\t")}\n${lines.join("\n")}\n`,
    result,
    command,
    continuationCommand,
  );
}

function renderExecutorDetails(result: JsonValue): string {
  if (!isRecord(result)) return `${JSON.stringify(result, null, 2)}\n`;
  const ref = referenceText(result["ref"]) ?? "unknown";
  const availability = recordValue(result, "availability");
  const project = recordValue(result, "project");
  const capabilities = recordValue(result, "capabilities");
  const refKind = referenceText(result["ref"])?.split(":", 1)[0];
  const runExample =
    refKind === "flow"
      ? `pragma flow run ${ref} --workspace "$PWD" --input-json input.json`
      : `pragma ${refKind ?? "expert"} run ${ref} --workspace "$PWD" --prompt "Your prompt"`;
  return (
    [
      `REF: ${ref}`,
      `NAME: ${valueText(result, "name") ?? "unknown"}`,
      `DESCRIPTION: ${valueText(result, "description") ?? ""}`,
      `SOURCE: ${valueText(result, "source") ?? "unknown"}`,
      `STATUS: ${valueText(availability, "status") ?? "unknown"}`,
      ...(project === undefined
        ? []
        : [
            `PROJECT: ${valueText(project, "projectId") ?? "unknown"}`,
            `REVISION: ${valueText(project, "revision") ?? "unknown"}`,
          ]),
      ...(capabilities === undefined
        ? []
        : [
            `CAPABILITIES: interactive=${booleanText(capabilities["interactive"])}, resumable=${booleanText(capabilities["resumable"])}, steerable=${booleanText(capabilities["steerable"])}, queue=${booleanText(capabilities["supportsQueue"])}`,
          ]),
      `NEXT: ${runExample}`,
    ].join("\n") + "\n"
  );
}

function renderMissionList(
  result: JsonValue,
  continuationCommand?: ((cursor: string) => string) | undefined,
): string {
  const items = arrayValue(result, "items");
  if (items.length === 0) {
    return appendContinuation("No missions found.\n", result, "mission.list", continuationCommand);
  }
  const lines = items.map((item) => {
    if (!isRecord(item)) return JSON.stringify(item);
    const executorValue = item["executor"];
    const executor =
      referenceText(isRecord(executorValue) ? executorValue["ref"] : undefined) ??
      referenceText(executorValue);
    const workspace = workspaceText(item["workspace"]);
    return [
      valueText(item, "missionId") ?? valueText(item, "id") ?? "unknown",
      valueText(item, "status") ?? valueText(item, "lifecycleStatus") ?? "unknown",
      executor ?? "-",
      valueText(item, "updatedAt") ?? "-",
      workspace ?? "-",
    ].join("\t");
  });
  return appendContinuation(
    `${["MISSION ID", "STATUS", "EXECUTOR", "UPDATED", "WORKSPACE"].join("\t")}\n${lines.join("\n")}\n`,
    result,
    "mission.list",
    continuationCommand,
  );
}

function renderMissionView(
  result: JsonValue,
  continuationCommand?: ((cursor: string) => string) | undefined,
): string {
  if (!isRecord(result)) return `${JSON.stringify(result, null, 2)}\n`;
  if (result["schemaVersion"] === "pragma.mission-summary/v1") return renderMissionSummary(result);
  if (result["schemaVersion"] === "pragma.mission-result/v1") return renderMissionResult(result);
  if (result["schemaVersion"] === "pragma.mission-events/v1") {
    return renderMissionEvents(result, continuationCommand);
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

function renderMissionSummary(result: Record<string, unknown>): string {
  const executor = referenceText(result["executor"]);
  const execution = recordValue(result, "execution");
  const workspace = workspaceText(result["workspace"]);
  return (
    [
      `MISSION ID: ${valueText(result, "missionId") ?? "unknown"}`,
      `STATUS: ${valueText(result, "status") ?? "unknown"}`,
      `LIFECYCLE: ${valueText(result, "lifecycleStatus") ?? "unknown"}`,
      `EXECUTOR: ${executor ?? "-"}`,
      `EXECUTION: ${valueText(execution, "id") ?? "-"}`,
      `UPDATED: ${valueText(result, "updatedAt") ?? "-"}`,
      `WORKSPACE: ${workspace ?? "-"}`,
      `CURSOR: ${valueText(result, "cursor") ?? "-"}`,
    ].join("\n") + "\n"
  );
}

function renderMissionResult(result: Record<string, unknown>): string {
  const lines = [
    `MISSION ID: ${valueText(result, "missionId") ?? "unknown"}`,
    `EXECUTION: ${valueText(result, "executionId") ?? "-"}`,
    `STATUS: ${valueText(result, "status") ?? "unknown"}`,
    `AVAILABLE: ${booleanText(result["available"])}`,
  ];
  if (result["available"] === true && result["result"] !== undefined) {
    lines.push(`RESULT:\n${JSON.stringify(result["result"], null, 2)}`);
  } else if (result["error"] !== undefined) {
    lines.push(`ERROR: ${JSON.stringify(result["error"], null, 2)}`);
  } else {
    const missionId = valueText(result, "missionId") ?? "<MISSION_ID>";
    const next =
      result["status"] === "waiting" && isRecord(result["interaction"])
        ? `mission respond ${missionId} --interaction ${valueText(result["interaction"], "interactionId") ?? "<INTERACTION_ID>"} ... (or mission watch ${missionId})`
        : `mission watch ${missionId}`;
    lines.push(`NEXT: ${next}`);
  }
  return lines.join("\n") + "\n";
}

function renderMissionEvents(
  result: Record<string, unknown>,
  continuationCommand?: ((cursor: string) => string) | undefined,
): string {
  const items = Array.isArray(result["items"]) ? result["items"] : [];
  const lines = items.map((item) => {
    if (!isRecord(item)) return JSON.stringify(item);
    return [
      valueText(item, "sequence") ?? "?",
      valueText(item, "occurredAt") ?? "-",
      valueText(item, "type") ?? "unknown",
      JSON.stringify(item["data"]),
    ].join("\t");
  });
  const body = `${["SEQUENCE", "OCCURRED AT", "TYPE", "DATA"].join("\t")}\n${lines.join("\n")}\n`;
  return appendContinuation(body, result, "mission.get", continuationCommand);
}

function renderQueueList(
  result: JsonValue,
  continuationCommand?: ((cursor: string) => string) | undefined,
): string {
  if (!isRecord(result)) return `${JSON.stringify(result, null, 2)}\n`;
  const items = Array.isArray(result["items"]) ? result["items"] : [];
  const header = [
    `state: ${valueText(result, "state") ?? "unknown"}`,
    `pendingCount: ${valueText(result, "pendingCount") ?? "0"}`,
    `supportsSteer: ${booleanText(result["supportsSteer"])}`,
    "",
    ["POSITION", "REQUEST ID", "STATUS", "STEERABLE", "CONTENT PREVIEW"].join("\t"),
  ].join("\n");
  const lines = items.map((item) => {
    if (!isRecord(item)) return JSON.stringify(item);
    return [
      valueText(item, "position") ?? "?",
      valueText(item, "requestId") ?? "unknown",
      valueText(item, "status") ?? "unknown",
      booleanText(item["steerable"]),
      contentPreview(item["content"]),
    ].join("\t");
  });
  return appendContinuation(
    `${header}\n${lines.join("\n")}\n`,
    result,
    "mission.queue.list",
    continuationCommand,
  );
}

function renderAcceptedText(command: string, result: JsonValue): string {
  return renderMutationText(command, result, true);
}

function renderMutationText(command: string, result: JsonValue, accepted: boolean): string {
  const record = isRecord(result) ? result : undefined;
  const operation = recordValue(record, "operation") ?? record;
  const operationResult = recordValue(operation, "result");
  const label = command.replace("mission.", "");
  const lines = [`${accepted ? "Accepted" : "Applied"}: ${label}`];
  const missionId =
    valueText(operation, "missionId") ??
    valueText(operationResult, "missionId") ??
    valueText(record, "missionId");
  const requestId = valueText(operation, "requestId") ?? valueText(record, "requestId");
  const operationId = valueText(operation, "operationId");
  const executionId =
    valueText(recordValue(record, "execution"), "executionId") ??
    valueText(operationResult, "executionId");
  const state = valueText(operation, "state");
  if (missionId !== undefined) lines.push(`Mission ID: ${missionId}`);
  if (requestId !== undefined) lines.push(`Request ID: ${requestId}`);
  if (operationId !== undefined) lines.push(`Operation ID: ${operationId}`);
  if (executionId !== undefined) lines.push(`Execution ID: ${executionId}`);
  if (state !== undefined) lines.push(`Status: ${state}`);
  if (lines.length === 1) lines.push(JSON.stringify(result));
  return lines.join("\n") + "\n";
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

function renderFailure(error: IntegrationError, requestId?: string): string {
  const credentials = error.details?.["credentials"];
  return `${requestId === undefined ? "" : `Request ID: ${requestId}\n`}${Array.isArray(credentials) ? renderCredentialFindings(credentials) : ""}${error.code}: ${error.message}\n`;
}

function resultValue(value: JsonValue, key: string): JsonValue | undefined {
  return isRecord(value) ? value[key] : undefined;
}

function valueText(value: Record<string, unknown> | undefined, key: string): string | undefined {
  const field = value?.[key];
  return typeof field === "string" || typeof field === "number" ? String(field) : undefined;
}

function arrayValue(value: JsonValue, key: string): readonly JsonValue[] {
  if (!isRecord(value) || !Array.isArray(value[key])) return [];
  return value[key] as readonly JsonValue[];
}

function recordValue(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> | undefined {
  const field = value?.[key];
  return isRecord(field) ? field : undefined;
}

function referenceText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return typeof value["kind"] === "string" && typeof value["id"] === "string"
    ? `${value["kind"]}:${value["id"]}`
    : undefined;
}

function workspaceText(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return undefined;
  return typeof value["canonicalPath"] === "string" ? value["canonicalPath"] : undefined;
}

function booleanText(value: unknown): string {
  return value === true ? "yes" : value === false ? "no" : "unknown";
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

function contentPreview(value: unknown): string {
  if (typeof value !== "string") return "";
  const compact = value.replace(/\s+/gu, " ").trim();
  return compact.length > 80 ? `${compact.slice(0, 77)}...` : compact;
}

function isMutationCommandName(command: string): boolean {
  return [
    "mission.send",
    "mission.steer",
    "mission.interrupt",
    "mission.respond",
    "mission.resume",
    "mission.queue.remove",
    "mission.queue.resume",
    "mission.queue.steer",
  ].includes(command);
}

function appendContinuation(
  body: string,
  result: unknown,
  command: string,
  continuationCommand?: ((cursor: string) => string) | undefined,
): string {
  if (!isRecord(result) || typeof result["nextCursor"] !== "string") return body;
  const cursor = result["nextCursor"];
  const continuation =
    continuationCommand?.(cursor) ?? defaultContinuationCommand(command, result, cursor);
  return `${body}Next cursor: ${cursor}\nContinue: ${continuation}\n`;
}

function defaultContinuationCommand(
  command: string,
  result: Record<string, unknown>,
  cursor: string,
): string {
  if (command === "mission.list") return `pragma mission list --cursor ${cursor}`;
  if (command === "mission.queue.list") {
    return `pragma mission queue list ${valueText(result, "missionId") ?? "<MISSION_ID>"} --cursor ${cursor}`;
  }
  if (command === "mission.get") {
    return `pragma mission get ${valueText(result, "missionId") ?? "<MISSION_ID>"} --view events --cursor ${cursor}`;
  }
  if (command.endsWith(".discover")) {
    return `pragma ${command.slice(0, command.indexOf("."))} discover --cursor ${cursor}`;
  }
  if (command === "mission.board.list") {
    return `pragma mission board list ${valueText(result, "missionId") ?? "<MISSION_ID>"} --cursor ${cursor}`;
  }
  return `pragma ${command.replaceAll(".", " ")} --cursor ${cursor}`;
}
