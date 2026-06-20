import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

const PI_SESSION_DIR = ".expertmesh/runtime-sessions/pi";

export async function createPiSessionManager(
  cwd: string,
  sessionId: string | undefined,
): Promise<SessionManager> {
  const sessionDir = getPiSessionDir(cwd);

  if (sessionId === undefined) {
    return SessionManager.create(cwd, sessionDir);
  }

  const existingSession = await findLocalSessionByExactId(sessionId, cwd, sessionDir);

  if (existingSession !== undefined) {
    return SessionManager.open(existingSession.path, sessionDir);
  }

  return SessionManager.create(cwd, sessionDir, { id: sessionId });
}

async function findLocalSessionByExactId(
  sessionId: string,
  cwd: string,
  sessionDir: string,
): Promise<SessionInfo | undefined> {
  const sessions = await SessionManager.list(cwd, sessionDir);
  return sessions.find((session) => session.id === sessionId);
}

export function getPiSessionDir(cwd: string): string {
  return join(cwd, PI_SESSION_DIR);
}
