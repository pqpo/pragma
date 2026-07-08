import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import type { RuntimeAdapterKind, RuntimeSessionRef } from "@pragma/core";
import { join } from "node:path";

const PI_SESSION_DIR = ".pragma/runtime-sessions/pi";

export interface PiSessionManagerResult {
  readonly sessionManager: SessionManager;
  readonly resumedExistingSession: boolean;
}

export async function createPiSessionManager(
  cwd: string,
  agentId: string,
  runtimeSession: RuntimeSessionRef | undefined,
  expectedRuntimeSessionType: RuntimeAdapterKind,
): Promise<PiSessionManagerResult> {
  const sessionDir = getPiSessionDir(cwd, agentId);

  if (runtimeSession === undefined || runtimeSession.type !== expectedRuntimeSessionType) {
    return {
      sessionManager: SessionManager.create(cwd, sessionDir),
      resumedExistingSession: false,
    };
  }

  const sessionId = runtimeSession.id;
  const existingSession = await findLocalSessionByExactId(sessionId, sessionDir);

  if (existingSession !== undefined) {
    return {
      sessionManager: SessionManager.open(existingSession.path, sessionDir, cwd),
      resumedExistingSession: true,
    };
  }

  return {
    sessionManager: SessionManager.create(cwd, sessionDir, { id: sessionId }),
    resumedExistingSession: false,
  };
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
