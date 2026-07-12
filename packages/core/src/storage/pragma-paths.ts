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

  workflowsRoot(): string {
    return join(this.stateRoot(), "workflows");
  }

  systemSessionOwnersRoot(): string {
    return join(this.workflowsRoot(), ".system-session-owners");
  }

  systemSessionOwner(systemSessionId: string): string {
    return join(this.systemSessionOwnersRoot(), `${encodePragmaPathSegment(systemSessionId)}.json`);
  }

  workflowRoot(workflowRunId: string): string {
    return join(this.workflowsRoot(), encodePragmaPathSegment(workflowRunId));
  }

  workflowState(workflowRunId: string): string {
    return join(this.workflowRoot(workflowRunId), "workflow.json");
  }

  workflowEvents(rootWorkflowRunId: string): string {
    return join(this.workflowRoot(rootWorkflowRunId), "events.jsonl");
  }

  workflowStateLock(): string {
    return join(this.workflowsRoot(), ".workflow-state.lock");
  }

  workflowEventsLock(rootWorkflowRunId: string): string {
    return join(this.workflowRoot(rootWorkflowRunId), ".events.lock");
  }

  workflowSessionsRoot(workflowRunId: string): string {
    return join(this.workflowRoot(workflowRunId), "sessions");
  }

  systemSessionRoot(workflowRunId: string, systemSessionId: string): string {
    return join(this.workflowSessionsRoot(workflowRunId), encodePragmaPathSegment(systemSessionId));
  }

  systemSessionManifest(workflowRunId: string, systemSessionId: string): string {
    return join(this.systemSessionRoot(workflowRunId, systemSessionId), "session.json");
  }

  runtimeRoot(workflowRunId: string, systemSessionId: string, runtimeName: string): string {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(runtimeName)) {
      throw new Error(`Invalid Pragma runtime storage name: ${runtimeName}.`);
    }
    return join(this.systemSessionRoot(workflowRunId, systemSessionId), "runtime", runtimeName);
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
