import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface PragmaPathsOptions {
  readonly pragmaHome?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}

/** Encode an external identifier as one collision-free, path-safe directory segment. */
export function encodePragmaPathSegment(value: string): string {
  if (value.length === 0) {
    throw new Error("Pragma path identifiers must not be empty.");
  }

  return Buffer.from(value, "utf8").toString("base64url");
}

export class PragmaPaths {
  readonly root: string;

  constructor(options: PragmaPathsOptions = {}) {
    const configuredRoot =
      options.pragmaHome ?? options.env?.["PRAGMA_HOME"] ?? process.env["PRAGMA_HOME"];
    this.root = resolve(
      configuredRoot === undefined || configuredRoot.trim() === ""
        ? join(homedir(), ".pragma")
        : configuredRoot,
    );
  }

  stateRoot(): string {
    return join(this.root, "state");
  }

  expertSessionsRoot(): string {
    return join(this.stateRoot(), "expert-sessions");
  }

  expertSessionRoot(sessionId: string): string {
    return join(this.expertSessionsRoot(), encodePragmaPathSegment(sessionId));
  }

  expertSessionState(sessionId: string): string {
    return join(this.expertSessionRoot(sessionId), "session.json");
  }

  expertSessionPrompts(sessionId: string): string {
    return join(this.expertSessionRoot(sessionId), "prompts.json");
  }

  expertSessionEvents(sessionId: string): string {
    return join(this.expertSessionRoot(sessionId), "events.json");
  }

  expertSessionTransaction(sessionId: string): string {
    return join(this.expertSessionRoot(sessionId), "transaction.json");
  }

  expertSessionLease(sessionId: string): string {
    return join(this.expertSessionRoot(sessionId), "lease.json");
  }

  expertSessionLock(sessionId: string): string {
    return join(this.expertSessionRoot(sessionId), ".lock");
  }

  executionsRoot(): string {
    return join(this.stateRoot(), "executions");
  }

  executionRoot(executionId: string): string {
    return join(this.executionsRoot(), encodePragmaPathSegment(executionId));
  }

  executionState(executionId: string): string {
    return join(this.executionRoot(executionId), "execution.json");
  }

  executionInvocations(executionId: string): string {
    return join(this.executionRoot(executionId), "invocations.json");
  }

  executionAgents(executionId: string): string {
    return join(this.executionRoot(executionId), "agents.json");
  }

  executionContexts(executionId: string): string {
    return join(this.executionRoot(executionId), "contexts.json");
  }

  executionEvents(executionId: string): string {
    return join(this.executionRoot(executionId), "events.jsonl");
  }

  executionCommits(executionId: string): string {
    return join(this.executionRoot(executionId), "commits.json");
  }

  executionTransaction(executionId: string): string {
    return join(this.executionRoot(executionId), "transaction.json");
  }

  executionLock(executionId: string): string {
    return join(this.executionRoot(executionId), ".lock");
  }

  runtimeSessionOwnersRoot(): string {
    return join(this.stateRoot(), "runtime-session-owners");
  }

  runtimeSessionOwner(systemSessionId: string): string {
    return join(
      this.runtimeSessionOwnersRoot(),
      `${encodePragmaPathSegment(systemSessionId)}.json`,
    );
  }

  runtimeSessionsRoot(): string {
    return join(this.stateRoot(), "runtime-sessions");
  }

  runtimeOwnerRoot(ownerId: string): string {
    return join(this.runtimeSessionsRoot(), encodePragmaPathSegment(ownerId));
  }

  ownedSystemSessionRoot(ownerId: string, systemSessionId: string): string {
    return join(this.runtimeOwnerRoot(ownerId), encodePragmaPathSegment(systemSessionId));
  }

  ownedSystemSessionManifest(ownerId: string, systemSessionId: string): string {
    return join(this.ownedSystemSessionRoot(ownerId, systemSessionId), "session.json");
  }

  ownedRuntimeRoot(ownerId: string, systemSessionId: string, runtimeName: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(runtimeName)) {
      throw new Error(`Invalid Pragma runtime storage name: ${runtimeName}.`);
    }
    return join(this.ownedSystemSessionRoot(ownerId, systemSessionId), "runtime", runtimeName);
  }

  agentsCacheRoot(): string {
    return join(this.root, "cache", "agents");
  }

  agentCacheRoot(agentId: string): string {
    return join(this.agentsCacheRoot(), encodePragmaPathSegment(agentId));
  }

  agentPluginsRoot(agentId: string): string {
    return join(this.agentCacheRoot(agentId), "plugins");
  }

  agentPluginRoot(agentId: string, pluginId: string): string {
    return join(this.agentPluginsRoot(agentId), encodePragmaPathSegment(pluginId));
  }
}
