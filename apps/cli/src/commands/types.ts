import type { LocalHostApplicationPort } from "@pragma/local-host";
import type { IntegrationError, JsonValue } from "@pragma/local-host/wire";

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
  | "listExecutors"
  | "getMission"
  | "listMissions"
  | "listSharedBoard"
  | "readSharedBoard"
  | "searchSharedBoard"
  | "listMissionQueue"
>;

export interface CliCommandContext {
  readonly requestId: string;
  readonly cliVersion: string;
  readonly startedAt: Date;
  readonly localHost: CliLocalHost;
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
