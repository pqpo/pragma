import {
  CliEventStreamSchema,
  CliResultSchema,
  integrationErrorExitCode,
  type IntegrationError,
  type JsonValue,
} from "@pragma/local-host/wire";

import { HELP_TEXT, type OutputFormat } from "../parser/argv.ts";
import { isRecord } from "../commands/utils.ts";

export type CliIo = Readonly<{
  readonly writeStdout: (value: string) => void;
  readonly writeStderr: (value: string) => void;
}>;

export interface PresentationInput {
  readonly io: CliIo;
  readonly format: OutputFormat;
  readonly requestId: string;
  readonly command: string;
  readonly cliVersion: string;
  readonly startedAt: Date;
}

export function presentSuccess(input: PresentationInput, result: JsonValue): void {
  if (input.format === "text") {
    input.io.writeStdout(renderText(input.command, result));
    return;
  }
  if (input.format === "json") {
    input.io.writeStdout(`${JSON.stringify(makeResult(input, result))}\n`);
    return;
  }
  const events = makeEventStream(input, result);
  input.io.writeStdout(`${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
}

export function presentFailure(
  input: PresentationInput,
  error: IntegrationError,
  options: Readonly<{ readonly textToStdout?: boolean }> = {},
): void {
  if (input.format === "json") {
    input.io.writeStdout(`${JSON.stringify(makeResult(input, undefined, error))}\n`);
    return;
  }
  if (input.format === "jsonl") {
    const event = makeEndEvent(input, error);
    input.io.writeStdout(`${JSON.stringify(event)}\n`);
    return;
  }
  const text = renderFailure(error);
  if (options.textToStdout === true) input.io.writeStdout(text);
  else input.io.writeStderr(text);
}

function makeResult(
  input: PresentationInput,
  result: JsonValue | undefined,
  error?: IntegrationError,
) {
  const completedAt = new Date();
  return CliResultSchema.parse({
    schemaVersion: "pragma.cli-result/v1",
    requestId: input.requestId,
    command: input.command,
    ok: error === undefined,
    ...(error === undefined ? { result } : { error }),
    warnings: [],
    meta: {
      startedAt: input.startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - input.startedAt.getTime()),
      cliVersion: input.cliVersion,
      protocolVersion: "pragma.integration/v1",
    },
  });
}

function makeEventStream(input: PresentationInput, result: JsonValue) {
  const emittedAt = new Date().toISOString();
  const events = [
    {
      schemaVersion: "pragma.cli-event/v1" as const,
      requestId: input.requestId,
      eventId: globalThis.crypto.randomUUID(),
      sequence: 1,
      emittedAt,
      replayable: false,
      type: "command.result" as const,
      data: { command: input.command, result },
    },
    makeEndEvent(input),
  ];
  return CliEventStreamSchema.parse(events);
}

function makeEndEvent(input: PresentationInput, error?: IntegrationError) {
  return {
    schemaVersion: "pragma.cli-event/v1" as const,
    requestId: input.requestId,
    eventId: globalThis.crypto.randomUUID(),
    sequence: error === undefined ? 2 : 1,
    emittedAt: new Date().toISOString(),
    replayable: false,
    type: "stream.end" as const,
    data: {
      status: error === undefined ? ("completed" as const) : ("failed" as const),
      exitCode: error === undefined ? 0 : integrationErrorExitCode(error.code),
      ...(error === undefined ? {} : { error }),
    },
  };
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
