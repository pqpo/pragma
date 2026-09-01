import type { ExpertSession } from "@pragma/core";

export class MissionSessionService<TExecutionContext, TExecutorMetadata = never> {
  readonly #executionContexts = new Map<string, Promise<TExecutionContext>>();
  readonly #sessions = new Map<string, ExpertSession>();
  readonly #compilationIdentities = new Map<string, string>();
  readonly #definitionFingerprints = new Map<string, string>();
  readonly #successorRequired = new Set<string>();
  readonly #contextBindingsChanging = new Set<string>();
  readonly #memoryBindingsChanged = new Set<string>();
  readonly #executorMetadata = new Map<string, TExecutorMetadata>();

  executorMetadata(projectKey: string): TExecutorMetadata | undefined {
    return this.#executorMetadata.get(projectKey);
  }

  setExecutorMetadata(projectKey: string, metadata: TExecutorMetadata): void {
    this.#executorMetadata.set(projectKey, metadata);
  }

  executionContext(missionId: string): Promise<TExecutionContext> | undefined {
    return this.#executionContexts.get(missionId);
  }

  setExecutionContext(missionId: string, context: Promise<TExecutionContext>): void {
    this.#executionContexts.set(missionId, context);
  }

  deleteExecutionContextIfCurrent(missionId: string, expected: Promise<TExecutionContext>): void {
    if (this.#executionContexts.get(missionId) === expected) {
      this.#executionContexts.delete(missionId);
    }
  }

  deleteExecutionContext(missionId: string): void {
    this.#executionContexts.delete(missionId);
  }

  session(missionId: string): ExpertSession | undefined {
    return this.#sessions.get(missionId);
  }

  setSession(missionId: string, session: ExpertSession): void {
    this.#sessions.set(missionId, session);
  }

  deleteSession(missionId: string): void {
    this.#sessions.delete(missionId);
  }

  sessionEntries(): IterableIterator<[string, ExpertSession]> {
    return this.#sessions.entries();
  }

  compilationIdentity(missionId: string): string | undefined {
    return this.#compilationIdentities.get(missionId);
  }

  setCompilationIdentity(missionId: string, identity: string): void {
    this.#compilationIdentities.set(missionId, identity);
  }

  definitionFingerprint(missionId: string): string | undefined {
    return this.#definitionFingerprints.get(missionId);
  }

  setDefinitionFingerprint(missionId: string, fingerprint: string): void {
    this.#definitionFingerprints.set(missionId, fingerprint);
  }

  clearCompilation(missionId: string): void {
    this.#compilationIdentities.delete(missionId);
    this.#definitionFingerprints.delete(missionId);
  }

  requireSuccessor(missionId: string): void {
    this.#successorRequired.add(missionId);
  }

  successorRequired(missionId: string): boolean {
    return this.#successorRequired.has(missionId);
  }

  clearSuccessorRequirement(missionId: string): void {
    this.#successorRequired.delete(missionId);
  }

  beginContextBindingChange(missionId: string): boolean {
    if (this.#contextBindingsChanging.has(missionId)) return false;
    this.#contextBindingsChanging.add(missionId);
    return true;
  }

  finishContextBindingChange(missionId: string): void {
    this.#contextBindingsChanging.delete(missionId);
  }

  contextBindingChangeInProgress(missionId: string): boolean {
    return this.#contextBindingsChanging.has(missionId);
  }

  markMemoryBindingsChanged(missionId: string): void {
    this.#memoryBindingsChanged.add(missionId);
  }

  memoryBindingsChanged(missionId: string): boolean {
    return this.#memoryBindingsChanged.has(missionId);
  }

  clearMemoryBindingsChanged(missionId: string): void {
    this.#memoryBindingsChanged.delete(missionId);
  }

  consumeMemoryBindingsChanged(missionId: string): boolean {
    return this.#memoryBindingsChanged.delete(missionId);
  }

  consumeSuccessorRequirement(missionId: string): boolean {
    return this.#successorRequired.delete(missionId);
  }

  invalidateContextBindings(missionId: string): void {
    this.deleteExecutionContext(missionId);
    this.clearCompilation(missionId);
    this.requireSuccessor(missionId);
  }
}
