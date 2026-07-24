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

  dataRoot(): string {
    return join(this.root, "data");
  }

  workspaceRoot(): string {
    return join(this.root, "workspace");
  }

  cacheRoot(): string {
    return join(this.root, "cache");
  }

  archivesRoot(): string {
    return join(this.root, "archives");
  }

  temporaryRoot(): string {
    return join(this.root, "tmp");
  }

  trashRoot(): string {
    return join(this.root, "trash");
  }

  storageVersion(): string {
    return join(this.root, "storage.json");
  }

  storageStateRoot(): string {
    return join(this.stateRoot(), "storage");
  }

  storageCatalog(): string {
    return join(this.storageStateRoot(), "catalog.sqlite");
  }

  storageGcLock(): string {
    return join(this.storageStateRoot(), ".gc.lock");
  }

  deletionJournalRoot(): string {
    return join(this.storageStateRoot(), "deletion-journal");
  }

  contentObjectsRoot(): string {
    return join(this.dataRoot(), "objects", "sha256");
  }

  projectsRoot(): string {
    return join(this.dataRoot(), "projects");
  }

  missionsRoot(): string {
    return join(this.dataRoot(), "missions");
  }

  automationBindingsRoot(): string {
    return join(this.dataRoot(), "automation-bindings");
  }

  automationBinding(automationRef: string): string {
    return join(this.automationBindingsRoot(), `${encodePragmaPathSegment(automationRef)}.json`);
  }

  automationsStateRoot(): string {
    return join(this.stateRoot(), "automations");
  }

  automationStateRoot(automationRef: string): string {
    return join(this.automationsStateRoot(), encodePragmaPathSegment(automationRef));
  }

  automationState(automationRef: string): string {
    return join(this.automationStateRoot(automationRef), "state.json");
  }

  automationLock(automationRef: string): string {
    return join(this.automationStateRoot(automationRef), ".lock");
  }

  credentialsRoot(): string {
    return join(this.dataRoot(), "credentials");
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

  expertSessionMigration(sessionId: string): string {
    return join(this.expertSessionRoot(sessionId), "state-migration.json");
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

  executionHandoffsRoot(executionId: string): string {
    return join(this.executionRoot(executionId), "handoffs");
  }

  executionHandoffsManifest(executionId: string): string {
    return join(this.executionHandoffsRoot(executionId), "manifest.json");
  }

  executionGeneratedHandoffsRoot(executionId: string): string {
    return join(this.executionHandoffsRoot(executionId), "generated");
  }

  executionEvents(executionId: string): string {
    return join(this.executionRoot(executionId), "events.jsonl");
  }

  executionArchivesRoot(): string {
    return join(this.archivesRoot(), "executions");
  }

  executionArchive(executionId: string): string {
    return join(this.executionArchivesRoot(), `${encodePragmaPathSegment(executionId)}.jsonl.gz`);
  }

  executionCommits(executionId: string): string {
    return join(this.executionRoot(executionId), "commits.json");
  }

  executionTransaction(executionId: string): string {
    return join(this.executionRoot(executionId), "transaction.json");
  }

  executionMigration(executionId: string): string {
    return join(this.executionRoot(executionId), "state-migration.json");
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

  runtimeEnvironmentsRoot(): string {
    return join(this.stateRoot(), "runtime-environments");
  }

  runtimeEnvironmentCatalog(): string {
    return join(this.runtimeEnvironmentsRoot(), "catalog.json");
  }

  runtimeEnvironmentRoot(runtimeId: string): string {
    return join(this.runtimeEnvironmentsRoot(), encodePragmaPathSegment(runtimeId));
  }

  runtimeEnvironmentRevision(runtimeId: string, revision: number): string {
    if (!Number.isSafeInteger(revision) || revision <= 0) {
      throw new Error(`Invalid Runtime Environment revision: ${revision}.`);
    }
    return join(this.runtimeEnvironmentRoot(runtimeId), "revisions", `${revision}.json`);
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
    return join(this.cacheRoot(), "agents");
  }

  pluginPackagesCacheRoot(): string {
    return join(this.cacheRoot(), "plugins", "sha256");
  }

  pluginPackageCache(packageFingerprint: string): string {
    if (!/^[a-f0-9]{64}$/.test(packageFingerprint)) {
      throw new Error(`Invalid plugin package fingerprint: ${packageFingerprint}.`);
    }
    return join(this.pluginPackagesCacheRoot(), packageFingerprint.slice(0, 2), packageFingerprint);
  }

  codexRuntimeCacheRoot(): string {
    return join(this.cacheRoot(), "runtimes", "codex");
  }

  projectViewsCacheRoot(): string {
    return join(this.cacheRoot(), "project-views");
  }

  agentCacheRoot(agentId: string): string {
    return join(this.agentsCacheRoot(), encodePragmaPathSegment(agentId));
  }

  agentPluginBindingsRoot(agentId: string): string {
    return join(this.agentCacheRoot(agentId), "bindings");
  }

  agentPluginBinding(agentId: string, pluginRef: string): string {
    return join(
      this.agentPluginBindingsRoot(agentId),
      `${encodePragmaPathSegment(pluginRef)}.json`,
    );
  }

  agentPluginsRoot(agentId: string): string {
    return join(this.agentCacheRoot(agentId), "plugins");
  }

  agentPluginRoot(agentId: string, pluginId: string): string {
    return join(this.agentPluginsRoot(agentId), encodePragmaPathSegment(pluginId));
  }

  versionedAgentPluginRoot(agentId: string, pluginId: string, version: string): string {
    return join(this.agentPluginRoot(agentId, pluginId), encodePragmaPathSegment(version));
  }

  fingerprintedAgentPluginRoot(
    agentId: string,
    pluginId: string,
    version: string,
    packageFingerprint: string,
  ): string {
    return join(
      this.versionedAgentPluginRoot(agentId, pluginId, version),
      encodePragmaPathSegment(packageFingerprint),
    );
  }

  pluginsRoot(): string {
    return join(this.dataRoot(), "plugins");
  }

  pluginStateRoot(): string {
    return join(this.dataRoot(), "plugin-state");
  }

  pluginState(pluginRef: string): string {
    return join(this.pluginStateRoot(), encodePragmaPathSegment(pluginRef));
  }

  pluginConfigState(pluginRef: string): string {
    return join(this.pluginState(pluginRef), "config.json");
  }

  pluginMutationLock(pluginRef: string): string {
    return join(this.pluginState(pluginRef), ".mutation.lock");
  }
}
