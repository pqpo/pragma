import type {
  LocalHostResolvedSecretEnvironment,
  LocalHostResolvedPluginEnvironment,
} from "./compile-service.ts";
import type { ExpertSession } from "@pragma/core";
import type { LocalHostCoreActiveOwner } from "../core-control-adapter.ts";

export interface MissionControlIssue {
  readonly state: "interrupt_uncertain" | "recovery_failed" | "deletion_pending";
  readonly reasonCode: string;
  readonly observedAt: string;
}

export type MissionExecutionOwnerOrigin = "live" | "recovered";

export interface MissionOwnerRecoveryOptions {
  /** Host recovery wiring that already reserves this same owner admission. */
  readonly admission?: "acquire" | "owned";
  readonly discard?: (owner: LocalHostCoreActiveOwner) => Promise<void>;
}

/** The exact same access object is supplied to first-run and command wiring. */
export interface MissionExecutionOwnerAccess {
  controlOwner(missionId: string): LocalHostCoreActiveOwner | undefined;
  controlOwnerOrigin(missionId: string): MissionExecutionOwnerOrigin | undefined;
  setControlOwner(
    missionId: string,
    owner: LocalHostCoreActiveOwner,
    origin: MissionExecutionOwnerOrigin,
  ): void;
  deleteControlOwnerIfCurrent(missionId: string, expected: LocalHostCoreActiveOwner): boolean;
  recoverControlOwner(
    missionId: string,
    create: () => Promise<LocalHostCoreActiveOwner>,
    options?: MissionOwnerRecoveryOptions,
  ): Promise<LocalHostCoreActiveOwner>;
  admit<T>(missionId: string, operation: () => Promise<T>): Promise<T>;
}

interface OwnerRecord<TExecutionContext, TRun, TCompaction, TActive> {
  executionContext?: Promise<TExecutionContext>;
  session?: ExpertSession;
  compilationIdentity?: string;
  compilationSecrets?: readonly LocalHostResolvedSecretEnvironment[];
  compilationPlugins?: readonly LocalHostResolvedPluginEnvironment[];
  definitionFingerprint?: string;
  successorRequired?: boolean;
  contextBindingChanges?: number;
  memoryBindingsChanged?: boolean;
  run?: Promise<TRun>;
  runGeneration?: number;
  compaction?: Promise<TCompaction>;
  deletion?: Promise<void>;
  active?: TActive;
  controlIssue?: MissionControlIssue;
  controlOwner?: LocalHostCoreActiveOwner;
  controlOwnerOrigin?: MissionExecutionOwnerOrigin;
  recovery?: Promise<LocalHostCoreActiveOwner>;
  admission?: Promise<void>;
}

/**
 * Process-local Mission handles and admission. Durable authority remains in
 * the existing controller, ExpertSession and Execution stores. Desktop view
 * metadata belongs to its presentation services, not this registry.
 */
export class MissionExecutionOwner<
  TExecutionContext = unknown,
  TRun = unknown,
  TCompaction = unknown,
  TActive = unknown,
> implements MissionExecutionOwnerAccess {
  readonly #owners = new Map<string, OwnerRecord<TExecutionContext, TRun, TCompaction, TActive>>();
  #nextGeneration = 0;

  #prune(
    missionId: string,
    record: OwnerRecord<TExecutionContext, TRun, TCompaction, TActive>,
  ): void {
    if (this.#owners.get(missionId) !== record) return;
    if (Object.keys(record).every((key) => key === "runGeneration")) this.#owners.delete(missionId);
  }

  #record(missionId: string): OwnerRecord<TExecutionContext, TRun, TCompaction, TActive> {
    let record = this.#owners.get(missionId);
    if (record === undefined) {
      record = { runGeneration: this.#nextGeneration++ };
      this.#owners.set(missionId, record);
    }
    return record;
  }

  executionContext(missionId: string): Promise<TExecutionContext> | undefined {
    return this.#owners.get(missionId)?.executionContext;
  }
  setExecutionContext(missionId: string, context: Promise<TExecutionContext>): void {
    this.#record(missionId).executionContext = context;
  }
  deleteExecutionContextIfCurrent(missionId: string, expected: Promise<TExecutionContext>): void {
    if (this.executionContext(missionId) === expected) this.deleteExecutionContext(missionId);
  }
  deleteExecutionContext(missionId: string): void {
    const record = this.#owners.get(missionId);
    if (record !== undefined) {
      delete record.executionContext;
      this.#prune(missionId, record);
    }
  }
  session(missionId: string): ExpertSession | undefined {
    return this.#owners.get(missionId)?.session;
  }
  setSession(missionId: string, session: ExpertSession): void {
    const record = this.#record(missionId);
    record.session = session;
    if (record.controlOwner?.kind === "session" && record.controlOwner.session !== session) {
      // A successor invalidates the old handle. The compile/run wiring will
      // publish its matching executor before commands can use it.
      delete record.controlOwner;
      delete record.controlOwnerOrigin;
    }
  }
  deleteSession(missionId: string): void {
    const record = this.#owners.get(missionId);
    if (record === undefined) return;
    if (record.controlOwner?.kind === "session" && record.controlOwner.session === record.session) {
      delete record.controlOwner;
      delete record.controlOwnerOrigin;
    }
    delete record.session;
    this.#prune(missionId, record);
  }
  deleteSessionIfCurrent(missionId: string, expected: ExpertSession): boolean {
    if (this.session(missionId) !== expected) return false;
    this.deleteSession(missionId);
    return true;
  }
  *sessionEntries(): IterableIterator<[string, ExpertSession]> {
    for (const [id, record] of this.#owners)
      if (record.session !== undefined) yield [id, record.session];
  }
  compilationIdentity(missionId: string): string | undefined {
    return this.#owners.get(missionId)?.compilationIdentity;
  }
  setCompilationIdentity(missionId: string, identity: string): void {
    this.#record(missionId).compilationIdentity = identity;
  }
  compilationSecrets(missionId: string): readonly LocalHostResolvedSecretEnvironment[] | undefined {
    return this.#owners.get(missionId)?.compilationSecrets;
  }
  setCompilationSecrets(
    missionId: string,
    secrets: readonly LocalHostResolvedSecretEnvironment[] | undefined,
  ): void {
    const record = this.#record(missionId);
    if (secrets === undefined) delete record.compilationSecrets;
    else record.compilationSecrets = secrets;
    this.#prune(missionId, record);
  }
  compilationPlugins(missionId: string): readonly LocalHostResolvedPluginEnvironment[] | undefined {
    return this.#owners.get(missionId)?.compilationPlugins;
  }
  setCompilationPlugins(
    missionId: string,
    plugins: readonly LocalHostResolvedPluginEnvironment[] | undefined,
  ): void {
    const record = this.#record(missionId);
    if (plugins === undefined) delete record.compilationPlugins;
    else record.compilationPlugins = plugins;
    this.#prune(missionId, record);
  }
  definitionFingerprint(missionId: string): string | undefined {
    return this.#owners.get(missionId)?.definitionFingerprint;
  }
  setDefinitionFingerprint(missionId: string, fingerprint: string): void {
    this.#record(missionId).definitionFingerprint = fingerprint;
  }
  clearCompilation(missionId: string): void {
    const record = this.#owners.get(missionId);
    if (record === undefined) return;
    delete record.compilationIdentity;
    delete record.compilationSecrets;
    delete record.compilationPlugins;
    delete record.definitionFingerprint;
    this.#prune(missionId, record);
  }
  requireSuccessor(missionId: string): void {
    this.#record(missionId).successorRequired = true;
  }
  successorRequired(missionId: string): boolean {
    return this.#owners.get(missionId)?.successorRequired === true;
  }
  clearSuccessorRequirement(missionId: string): void {
    const record = this.#owners.get(missionId);
    if (record !== undefined) {
      delete record.successorRequired;
      this.#prune(missionId, record);
    }
  }
  consumeSuccessorRequirement(missionId: string): boolean {
    const required = this.successorRequired(missionId);
    this.clearSuccessorRequirement(missionId);
    return required;
  }
  beginContextBindingChange(missionId: string): void {
    const record = this.#record(missionId);
    record.contextBindingChanges = (record.contextBindingChanges ?? 0) + 1;
  }
  finishContextBindingChange(missionId: string): void {
    const record = this.#owners.get(missionId);
    if (record === undefined) return;
    const remaining = (record.contextBindingChanges ?? 1) - 1;
    if (remaining === 0) delete record.contextBindingChanges;
    else record.contextBindingChanges = remaining;
    this.#prune(missionId, record);
  }
  contextBindingChangeInProgress(missionId: string): boolean {
    return (this.#owners.get(missionId)?.contextBindingChanges ?? 0) > 0;
  }
  markMemoryBindingsChanged(missionId: string): void {
    this.#record(missionId).memoryBindingsChanged = true;
  }
  memoryBindingsChanged(missionId: string): boolean {
    return this.#owners.get(missionId)?.memoryBindingsChanged === true;
  }
  clearMemoryBindingsChanged(missionId: string): void {
    const record = this.#owners.get(missionId);
    if (record !== undefined) {
      delete record.memoryBindingsChanged;
      this.#prune(missionId, record);
    }
  }
  consumeMemoryBindingsChanged(missionId: string): boolean {
    const changed = this.memoryBindingsChanged(missionId);
    this.clearMemoryBindingsChanged(missionId);
    return changed;
  }
  invalidateContextBindings(missionId: string): void {
    this.deleteExecutionContext(missionId);
    this.clearCompilation(missionId);
    this.requireSuccessor(missionId);
  }

  active(missionId: string): TActive | undefined {
    return this.#owners.get(missionId)?.active;
  }
  hasActive(missionId: string): boolean {
    return this.#owners.get(missionId)?.active !== undefined;
  }
  isBusy(missionId: string): boolean {
    const record = this.#owners.get(missionId);
    return (
      record !== undefined &&
      (record.active !== undefined ||
        record.run !== undefined ||
        record.compaction !== undefined ||
        record.deletion !== undefined)
    );
  }
  busyMissionCount(): number {
    let count = 0;
    for (const id of this.#owners.keys()) if (this.isBusy(id)) count += 1;
    return count;
  }
  setActive(missionId: string, active: TActive): void {
    this.#record(missionId).active = active;
  }
  setActiveForRun(missionId: string, generation: number, active: TActive): boolean {
    if (!this.isRunGenerationCurrent(missionId, generation)) return false;
    this.setActive(missionId, active);
    return true;
  }
  deleteActiveIfCurrent(missionId: string, expected: TActive): void {
    if (this.active(missionId) === expected) this.deleteActive(missionId);
  }
  deleteActive(missionId: string): void {
    const record = this.#owners.get(missionId);
    if (record !== undefined) {
      delete record.active;
      this.#prune(missionId, record);
    }
  }
  run(missionId: string): Promise<TRun> | undefined {
    return this.#owners.get(missionId)?.run;
  }
  /** Invalidates a run and every late completion that belongs to its generation. */
  forgetRun(missionId: string): void {
    const record = this.#record(missionId);
    record.runGeneration = this.#nextGeneration++;
    delete record.run;
    this.#prune(missionId, record);
  }
  runGeneration(missionId: string): number {
    return this.#record(missionId).runGeneration!;
  }
  isRunGenerationCurrent(missionId: string, generation: number): boolean {
    return this.#owners.get(missionId)?.runGeneration === generation;
  }
  startRun(missionId: string, create: (generation: number) => Promise<TRun>): Promise<TRun> {
    const record = this.#record(missionId);
    if (record.run !== undefined) return record.run;
    const started = create(this.runGeneration(missionId));
    record.run = started;
    const clear = () => {
      if (record.run === started) delete record.run;
      this.#prune(missionId, record);
    };
    void started.then(clear, clear);
    return started;
  }
  startCompaction(missionId: string, create: () => Promise<TCompaction>): Promise<TCompaction> {
    const record = this.#record(missionId);
    if (record.compaction !== undefined) return record.compaction;
    const started = create();
    record.compaction = started;
    const clear = () => {
      if (record.compaction === started) delete record.compaction;
      this.#prune(missionId, record);
    };
    void started.then(clear, clear);
    return started;
  }
  startDeletion(missionId: string, create: () => Promise<void>): Promise<void> {
    const record = this.#record(missionId);
    if (record.deletion !== undefined) return record.deletion;
    const started = create();
    record.deletion = started;
    const clear = () => {
      if (record.deletion === started) delete record.deletion;
      this.#prune(missionId, record);
    };
    void started.then(clear, clear);
    return started;
  }
  markLeaseLost(missionId: string): void {
    this.forgetRun(missionId);
  }
  controlIssue(missionId: string): MissionControlIssue | undefined {
    return this.#owners.get(missionId)?.controlIssue;
  }
  setControlIssue(missionId: string, issue: MissionControlIssue): void {
    this.#record(missionId).controlIssue = issue;
  }
  clearControlIssue(missionId: string): void {
    const record = this.#owners.get(missionId);
    if (record !== undefined) {
      delete record.controlIssue;
      this.#prune(missionId, record);
    }
  }

  controlOwner(missionId: string): LocalHostCoreActiveOwner | undefined {
    return this.#owners.get(missionId)?.controlOwner;
  }
  controlOwnerOrigin(missionId: string): MissionExecutionOwnerOrigin | undefined {
    return this.#owners.get(missionId)?.controlOwnerOrigin;
  }
  setControlOwner(
    missionId: string,
    owner: LocalHostCoreActiveOwner,
    origin: MissionExecutionOwnerOrigin,
  ): void {
    const record = this.#record(missionId);
    if (owner.kind === "session") record.session = owner.session;
    record.controlOwner = owner;
    record.controlOwnerOrigin = origin;
  }
  deleteControlOwnerIfCurrent(missionId: string, expected: LocalHostCoreActiveOwner): boolean {
    const record = this.#owners.get(missionId);
    if (record?.controlOwner !== expected) return false;
    delete record.controlOwner;
    delete record.controlOwnerOrigin;
    if (expected.kind === "session" && record.session === expected.session) delete record.session;
    this.#prune(missionId, record);
    return true;
  }
  recoverControlOwner(
    missionId: string,
    create: () => Promise<LocalHostCoreActiveOwner>,
    options: MissionOwnerRecoveryOptions = {},
  ): Promise<LocalHostCoreActiveOwner> {
    const record = this.#record(missionId);
    if (record.controlOwner !== undefined) return Promise.resolve(record.controlOwner);
    if (record.recovery !== undefined) return record.recovery;
    const generation = this.runGeneration(missionId);
    const acquire = async (): Promise<LocalHostCoreActiveOwner> => {
      if (!this.isRunGenerationCurrent(missionId, generation))
        throw new Error("Mission owner changed during recovery.");
      if (record.controlOwner !== undefined) return record.controlOwner;
      const owner = await create();
      if (!this.isRunGenerationCurrent(missionId, generation)) {
        // Recovery ports may publish a Session before returning the handle.
        // Revoke only that publication before releasing it; a successor must
        // remain usable while the discarded owner's teardown settles.
        const publishedSession =
          owner.kind === "session" && this.session(missionId) === owner.session;
        const published = this.controlOwner(missionId);
        if (published !== undefined && sameOwnerHandle(published, owner))
          this.deleteControlOwnerIfCurrent(missionId, published);
        if (publishedSession && owner.kind === "session") {
          this.deleteSessionIfCurrent(missionId, owner.session);
          this.clearCompilation(missionId);
        }
        await (options.discard ?? discardRecoveredOwner)(owner);
        throw new Error("Mission owner changed during recovery.");
      }
      // A Host callback may publish the first-run handle before it returns.
      if (record.controlOwner !== undefined && record.controlOwner !== owner) {
        if (!sameOwnerHandle(record.controlOwner, owner))
          await (options.discard ?? discardRecoveredOwner)(owner);
        return record.controlOwner;
      }
      this.setControlOwner(missionId, owner, "recovered");
      return owner;
    };
    const recovery = options.admission === "owned" ? acquire() : this.admit(missionId, acquire);
    record.recovery = recovery;
    const clear = () => {
      if (record.recovery === recovery) delete record.recovery;
      this.#prune(missionId, record);
    };
    void recovery.then(clear, clear);
    return recovery;
  }
  /** Failed admission does not poison later commands; unrelated owners are independent. */
  admit<T>(missionId: string, operation: () => Promise<T>): Promise<T> {
    const record = this.#record(missionId);
    const admitted = (record.admission ?? Promise.resolve()).then(operation);
    const tail = admitted.then(
      () => undefined,
      () => undefined,
    );
    record.admission = tail;
    void tail.then(() => {
      if (record.admission === tail) delete record.admission;
      this.#prune(missionId, record);
    });
    return admitted;
  }
}

function sameOwnerHandle(left: LocalHostCoreActiveOwner, right: LocalHostCoreActiveOwner): boolean {
  return left.kind === "session" && right.kind === "session"
    ? left.session === right.session
    : left.kind === "flow" && right.kind === "flow" && left.execution === right.execution;
}

async function discardRecoveredOwner(owner: LocalHostCoreActiveOwner): Promise<void> {
  if (owner.kind !== "session") return;
  const [state, prompts] = await Promise.all([
    owner.session.getState(),
    owner.session.getPromptQueue(),
  ]);
  if (
    state.activeExecutionId === undefined &&
    (state.lastStatus === "waiting" || prompts.some((prompt) => prompt.status === "queued"))
  ) {
    await owner.session.releaseAfterHumanCheckpoint();
  } else {
    await owner.session.releaseAfterTerminal({ waitForIdle: true });
  }
}
