import type { ExpertAgentStreamEvent } from "@expertmesh/contracts";

export type RuntimeStreamEvent = ExpertAgentStreamEvent;

export type RuntimeStreamEventSink = (event: RuntimeStreamEvent) => void | Promise<void>;

export interface RuntimeStreamOptions {
  readonly onEvent?: RuntimeStreamEventSink | undefined;
}

export async function emitRuntimeStreamEvent(
  sink: RuntimeStreamEventSink | undefined,
  event: RuntimeStreamEvent,
): Promise<void> {
  await sink?.(event);
}
