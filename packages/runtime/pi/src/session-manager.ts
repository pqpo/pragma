import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export interface PiSessionManagerResult {
  readonly sessionManager: SessionManager;
  readonly resumedExistingSession: boolean;
}

export async function createPiSessionManager(
  cwd: string,
  runtimeDir: string,
  runtimeSessionId: string | undefined,
): Promise<PiSessionManagerResult> {
  const sessionDir = getPiSessionDir(runtimeDir);

  if (runtimeSessionId === undefined) {
    return {
      sessionManager: SessionManager.create(cwd, sessionDir),
      resumedExistingSession: false,
    };
  }

  const existingSession = await findLocalSessionByExactId(runtimeSessionId, sessionDir);

  if (existingSession !== undefined) {
    return {
      sessionManager: SessionManager.open(existingSession.path, sessionDir, cwd),
      resumedExistingSession: true,
    };
  }

  throw new Error(`PI runtime session was not found: ${runtimeSessionId}.`);
}

async function findLocalSessionByExactId(
  sessionId: string,
  sessionDir: string,
): Promise<SessionInfo | undefined> {
  const sessions = await SessionManager.listAll(sessionDir);
  return sessions.find((session) => session.id === sessionId);
}

export function getPiSessionDir(runtimeDir: string): string {
  return join(runtimeDir, "sessions");
}
