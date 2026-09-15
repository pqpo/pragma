export interface MissionControlIssue {
  readonly state: "interrupt_uncertain" | "recovery_failed" | "deletion_pending";
  readonly reasonCode: string;
  readonly observedAt: string;
}

export class MissionLifecycleService<TRun, TCompaction, TActive> {
  readonly #runs = new Map<string, Promise<TRun>>();
  readonly #runGenerations = new Map<string, number>();
  readonly #compactions = new Map<string, Promise<TCompaction>>();
  readonly #deletions = new Map<string, Promise<void>>();
  readonly #active = new Map<string, TActive>();
  readonly #controlIssues = new Map<string, MissionControlIssue>();

  active(missionId: string): TActive | undefined {
    return this.#active.get(missionId);
  }

  hasActive(missionId: string): boolean {
    return this.#active.has(missionId);
  }

  setActive(missionId: string, active: TActive): void {
    this.#active.set(missionId, active);
  }

  setActiveForRun(missionId: string, generation: number, active: TActive): boolean {
    if (!this.isRunGenerationCurrent(missionId, generation)) return false;
    this.#active.set(missionId, active);
    return true;
  }

  deleteActiveIfCurrent(missionId: string, expected: TActive): void {
    if (this.#active.get(missionId) === expected) this.#active.delete(missionId);
  }

  deleteActive(missionId: string): void {
    this.#active.delete(missionId);
  }

  run(missionId: string): Promise<TRun> | undefined {
    return this.#runs.get(missionId);
  }

  /** Invalidates a run and every late completion that belongs to its generation. */
  forgetRun(missionId: string): void {
    this.#runGenerations.set(missionId, this.runGeneration(missionId) + 1);
    this.#runs.delete(missionId);
  }

  runGeneration(missionId: string): number {
    return this.#runGenerations.get(missionId) ?? 0;
  }

  isRunGenerationCurrent(missionId: string, generation: number): boolean {
    return this.runGeneration(missionId) === generation;
  }

  startRun(missionId: string, create: (generation: number) => Promise<TRun>): Promise<TRun> {
    const existing = this.#runs.get(missionId);
    if (existing !== undefined) return existing;
    const generation = this.runGeneration(missionId);
    const started = create(generation);
    this.#runs.set(missionId, started);
    const clear = () => {
      if (this.#runs.get(missionId) === started) this.#runs.delete(missionId);
    };
    void started.then(clear, clear);
    return started;
  }

  startCompaction(missionId: string, create: () => Promise<TCompaction>): Promise<TCompaction> {
    const existing = this.#compactions.get(missionId);
    if (existing !== undefined) return existing;
    const started = create();
    this.#compactions.set(missionId, started);
    const clear = () => {
      if (this.#compactions.get(missionId) === started) this.#compactions.delete(missionId);
    };
    void started.then(clear, clear);
    return started;
  }

  startDeletion(missionId: string, create: () => Promise<void>): Promise<void> {
    const existing = this.#deletions.get(missionId);
    if (existing !== undefined) return existing;
    const started = create();
    this.#deletions.set(missionId, started);
    const clear = () => {
      if (this.#deletions.get(missionId) === started) this.#deletions.delete(missionId);
    };
    void started.then(clear, clear);
    return started;
  }

  markLeaseLost(missionId: string): void {
    this.forgetRun(missionId);
  }

  controlIssue(missionId: string): MissionControlIssue | undefined {
    return this.#controlIssues.get(missionId);
  }

  setControlIssue(missionId: string, issue: MissionControlIssue): void {
    this.#controlIssues.set(missionId, issue);
  }

  clearControlIssue(missionId: string): void {
    this.#controlIssues.delete(missionId);
  }
}
