import type { RuntimeSessionRef } from "@pragma/core";

export function sameRuntimeSession(
  left: RuntimeSessionRef | undefined,
  right: RuntimeSessionRef | undefined,
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left.type === right.type && left.id === right.id;
}

export function runtimeSessionKey(runtimeSession: RuntimeSessionRef): string {
  return JSON.stringify([runtimeSession.type, runtimeSession.id]);
}

export function dedupeRuntimeSessions(sessions: readonly RuntimeSessionRef[]): RuntimeSessionRef[] {
  const seen = new Set<string>();

  return sessions.filter((session) => {
    const key = runtimeSessionKey(session);
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}
