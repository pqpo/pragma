import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { SessionInfo } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { cp, readdir, rm } from "node:fs/promises";

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

  let existingSession = await findLocalSessionByExactId(runtimeSessionId, sessionDir);

  if (existingSession === undefined) {
    existingSession = await findSessionAcrossWorkflows(runtimeSessionId, runtimeDir);
    if (existingSession !== undefined) {
      // Copy the session data to the current workflow's session directory
      const targetPath = join(sessionDir, existingSession.id);
      await rm(targetPath, { recursive: true, force: true });
      await cp(existingSession.path, targetPath, { recursive: true });
      existingSession = { ...existingSession, path: targetPath };
    }
  }

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

/**
 * Searches across all workflow session directories for a PI session.
 * The runtimeDir is at: workflows/<id>/sessions/<sid>/runtime/pi (6 segments)
 * Going up 5 levels gets to the workflows root.
 */
async function findSessionAcrossWorkflows(
  sessionId: string,
  runtimeDir: string,
): Promise<SessionInfo | undefined> {
  const workflowsRoot = resolve(runtimeDir, "..", "..", "..", "..", "..");
  let workflowDirs: string[];
  try {
    workflowDirs = await readdir(workflowsRoot);
  } catch {
    return undefined;
  }

  for (const workflowDir of workflowDirs) {
    const sessionsDir = join(workflowsRoot, workflowDir, "sessions");
    let systemSessionDirs: string[];
    try {
      systemSessionDirs = await readdir(sessionsDir);
    } catch {
      continue;
    }

    for (const systemSessionDir of systemSessionDirs) {
      const piSessionDir = join(
        sessionsDir,
        systemSessionDir,
        "runtime",
        "pi",
        "sessions",
      );

      if (piSessionDir === getPiSessionDir(runtimeDir)) {
        continue; // already checked the current directory
      }

      const session = await findLocalSessionByExactId(sessionId, piSessionDir);
      if (session !== undefined) {
        return session;
      }
    }
  }

  return undefined;
}

export function getPiSessionDir(runtimeDir: string): string {
  return join(runtimeDir, "sessions");
}
