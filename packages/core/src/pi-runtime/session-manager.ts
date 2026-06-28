import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { RuntimeAdapterKind, RuntimeSessionRef } from "@expertmesh/core";
import { join } from "node:path";

const PI_SESSION_DIR = ".expertmesh/runtime-sessions/pi";

export async function createPiSessionManager(
  cwd: string,
  agentId: string,
  runtimeSession: RuntimeSessionRef | undefined,
  expectedRuntimeSessionType: RuntimeAdapterKind,
): Promise<SessionManager> {
  const sessionDir = getPiSessionDir(cwd, agentId);

  if (runtimeSession === undefined || runtimeSession.type !== expectedRuntimeSessionType) {
    return SessionManager.create(cwd, sessionDir);
  }

  const sessionId = runtimeSession.id;
  const existingSession = await findLocalSessionByExactId(sessionId, sessionDir);

  if (existingSession !== undefined) {
    return SessionManager.open(existingSession.path, sessionDir, cwd);
  }

  return SessionManager.create(cwd, sessionDir, { id: sessionId });
}

async function findLocalSessionByExactId(
  sessionId: string,
  sessionDir: string,
): Promise<SessionInfo | undefined> {
  const sessions = await SessionManager.listAll(sessionDir);
  return sessions.find((session) => session.id === sessionId);
}

export function getPiSessionDir(cwd: string, agentId: string): string {
  return join(cwd, PI_SESSION_DIR, encodeURIComponent(agentId));
}
