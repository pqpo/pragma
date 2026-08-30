import type { LocalHostApplicationPort } from "@pragma/local-host";
import type { IntegrationError, JsonValue } from "@pragma/local-host/wire";
import type { InteractiveMode, OutputFormat } from "../parser/argv.ts";
import type { TerminalPort } from "../terminal.ts";

export type CliLocalHost = Pick<
  LocalHostApplicationPort<
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown,
    unknown
  >,
  | "integrationCapability"
  | "resolveWorkspace"
  | "listExecutors"
  | "getMission"
  | "listMissions"
  | "queryMission"
  | "listSharedBoard"
  | "readSharedBoard"
  | "searchSharedBoard"
  | "listMissionQueue"
  | "watchMission"
  | "resumeMission"
  | "missionControl"
  | "run"
>;

export interface CliCommandContext {
  readonly requestId: string;
  readonly cliVersion: string;
  readonly startedAt: Date;
  readonly localHost: CliLocalHost;
  readonly format: OutputFormat;
  readonly interactive: InteractiveMode;
  readonly terminal: TerminalPort;
}

export interface CliCommandFailure {
  readonly error: IntegrationError;
}

export interface CliCommandSuccess {
  readonly result: JsonValue;
}

export type CliCommandOutcome = CliCommandSuccess | CliCommandFailure;

export function isCommandFailure(value: CliCommandOutcome): value is CliCommandFailure {
  return "error" in value;
}
