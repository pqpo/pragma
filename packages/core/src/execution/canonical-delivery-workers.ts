import type { CanonicalEventHandoff } from "./canonical-event-handoff.ts";

export interface CanonicalDeliveryResult {
  readonly recovered: number;
  readonly deliveryFailure?: {
    readonly error: unknown;
    readonly file: string;
    readonly handoff: CanonicalEventHandoff;
  };
}

/** In-process scheduling only; durable handoffs remain the recovery authority. */
export class CanonicalDeliveryWorkers {
  private readonly workers = new Map<
    string,
    {
      dirty: boolean;
      promise: Promise<CanonicalDeliveryResult>;
    }
  >();

  constructor(
    private readonly deliver: (executionId: string) => Promise<CanonicalDeliveryResult>,
  ) {}

  markDirty(executionId: string): boolean {
    const worker = this.workers.get(executionId);
    if (worker === undefined) return false;
    worker.dirty = true;
    return true;
  }

  wait(executionId: string): Promise<CanonicalDeliveryResult> | undefined {
    return this.workers.get(executionId)?.promise;
  }

  request(executionId: string): Promise<CanonicalDeliveryResult> {
    if (this.markDirty(executionId)) return this.workers.get(executionId)!.promise;
    const worker = {
      dirty: false,
      promise: Promise.resolve({ recovered: 0 } as CanonicalDeliveryResult),
    };
    worker.promise = Promise.resolve().then(async () => {
      let recovered = 0;
      try {
        do {
          worker.dirty = false;
          const result = await this.deliver(executionId);
          recovered += result.recovered;
          if (result.deliveryFailure !== undefined) return { ...result, recovered };
        } while (worker.dirty);
        return { recovered };
      } finally {
        // No await/Promise.finally between the last dirty check and retirement.
        // A late request always starts a successor before drain can miss it.
        if (this.workers.get(executionId) === worker) this.workers.delete(executionId);
      }
    });
    this.workers.set(executionId, worker);
    return worker.promise;
  }

  async drain(): Promise<void> {
    while (this.workers.size > 0)
      await Promise.allSettled([...this.workers.values()].map((worker) => worker.promise));
  }
}
