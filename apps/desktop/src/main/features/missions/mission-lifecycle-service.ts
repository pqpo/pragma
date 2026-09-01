export class MissionLifecycleService<TRun, TCompaction, TActive> {
  readonly #runs = new Map<string, Promise<TRun>>();
  readonly #compactions = new Map<string, Promise<TCompaction>>();
  readonly #lostLeases = new Set<string>();
  readonly #active = new Map<string, TActive>();

  active(missionId: string): TActive | undefined {
    return this.#active.get(missionId);
  }

  hasActive(missionId: string): boolean {
    return this.#active.has(missionId);
  }

  setActive(missionId: string, active: TActive): void {
    this.#active.set(missionId, active);
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

  startRun(missionId: string, create: () => Promise<TRun>): Promise<TRun> {
    const existing = this.#runs.get(missionId);
    if (existing !== undefined) return existing;
    const started = create();
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

  markLeaseLost(missionId: string): void {
    this.#lostLeases.add(missionId);
  }

  leaseWasLost(missionId: string): boolean {
    return this.#lostLeases.has(missionId);
  }
}
