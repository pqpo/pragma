import type { RuntimeStreamEvent } from "@expertmesh/agent-core";
import { randomUUID } from "node:crypto";

import type { RuntimeStreamBridge } from "./types.ts";

export function createRuntimeStreamBridge(): RuntimeStreamBridge {
  return {
    nextSequence: createSequenceCounter(),
  };
}

export function createSequenceCounter(): () => number {
  let sequence = 0;

  return () => sequence++;
}

export function createChildRunId(parentRunId: string | undefined): string {
  return parentRunId === undefined
    ? `subagent-${randomUUID()}`
    : `${parentRunId}:subagent:${randomUUID()}`;
}

export function createStreamEvent(
  event: Omit<RuntimeStreamEvent, "schemaVersion" | "eventId" | "emittedAt">,
): RuntimeStreamEvent {
  return {
    schemaVersion: "expertmesh.stream/v1",
    eventId: randomUUID(),
    emittedAt: new Date().toISOString(),
    ...event,
  } as RuntimeStreamEvent;
}

export function summarizeInput(input: unknown): string {
  return summarizeText(
    typeof input === "string" ? input : (JSON.stringify(input) ?? String(input)),
  );
}

export function summarizeText(text: string): string {
  return text.length <= 240 ? text : `${text.slice(0, 237)}...`;
}
