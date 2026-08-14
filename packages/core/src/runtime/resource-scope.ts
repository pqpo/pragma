export type RuntimeResourceDisposer<T> = (resource: T) => Promise<void> | void;

export type RuntimeResourceReceiptState = "active" | "disposed" | "failed";

export interface RuntimeResourceReceipt {
  readonly label: string;
  readonly order: number;
  readonly state: RuntimeResourceReceiptState;
}

interface RuntimeResourceEntry {
  readonly label: string;
  readonly order: number;
  readonly dispose: () => Promise<void> | void;
  state: RuntimeResourceReceiptState;
}

/** Acquisition-only view passed to Runtime feature and driver code. */
export interface RuntimeResourceRegistrar {
  readonly acquire: <T>(
    label: string,
    acquire: () => Promise<T> | T,
    dispose: RuntimeResourceDisposer<T>,
  ) => Promise<T>;
  readonly adopt: <T>(label: string, resource: T, dispose: RuntimeResourceDisposer<T>) => T;
  readonly receipts: () => readonly RuntimeResourceReceipt[];
}

/**
 * Owns resources acquired while a Runtime Session or turn is being prepared.
 *
 * Resources are released exactly once in reverse acquisition order. Core keeps
 * ownership of the scope, so partial initialization failures use the same
 * cleanup path as normal Session shutdown.
 */
export class RuntimeResourceScope implements RuntimeResourceRegistrar {
  private readonly entries: RuntimeResourceEntry[] = [];
  private sealed = false;
  private transferred = false;
  private disposal: Promise<void> | undefined;

  constructor(readonly label: string) {
    if (label.trim() === "") {
      throw new Error("Runtime resource scope label must not be empty.");
    }
  }

  async acquire<T>(
    label: string,
    acquire: () => Promise<T> | T,
    dispose: RuntimeResourceDisposer<T>,
  ): Promise<T> {
    this.assertCanRegister();
    const resource = await acquire();
    try {
      return this.adopt(label, resource, dispose);
    } catch (error) {
      try {
        await dispose(resource);
      } catch (cleanupError) {
        throw new AggregateError(
          [error, cleanupError],
          `Runtime resource ${label} was acquired after its scope closed and cleanup failed.`,
          { cause: cleanupError },
        );
      }
      throw error;
    }
  }

  adopt<T>(label: string, resource: T, dispose: RuntimeResourceDisposer<T>): T {
    this.assertCanRegister();
    if (label.trim() === "") {
      throw new Error("Runtime resource label must not be empty.");
    }
    this.entries.push({
      label,
      order: this.entries.length,
      dispose: () => dispose(resource),
      state: "active",
    });
    return resource;
  }

  /**
   * Closes registration while retaining Core ownership for native Session
   * creation. A sealed scope can still be disposed when that creation fails.
   */
  seal(): void {
    this.assertCanRegister();
    this.sealed = true;
  }

  /**
   * Attaches a sealed child preparation scope to this scope. Core uses this to
   * preserve deterministic cleanup order when independent graph nodes run in
   * parallel.
   */
  attach(scope: RuntimeResourceScope): void {
    this.assertCanRegister();
    if (!scope.sealed) {
      throw new Error(`Runtime resource scope ${scope.label} must be sealed before attachment.`);
    }
    scope.transfer();
    this.entries.push({
      label: scope.label,
      order: this.entries.length,
      dispose: () => scope.dispose(),
      state: "active",
    });
  }

  /** Marks successful ownership transfer from preparation to its Core owner. */
  transfer(): void {
    if (!this.sealed) {
      throw new Error(`Runtime resource scope ${this.label} must be sealed before transfer.`);
    }
    if (this.disposal !== undefined) {
      throw new Error(`Runtime resource scope ${this.label} is closing.`);
    }
    if (this.transferred) {
      throw new Error(`Runtime resource scope ${this.label} has transferred ownership.`);
    }
    this.transferred = true;
  }

  receipts(): readonly RuntimeResourceReceipt[] {
    return this.entries.map(({ label, order, state }) => ({ label, order, state }));
  }

  dispose(): Promise<void> {
    this.disposal ??= this.disposeEntries();
    return this.disposal;
  }

  private async disposeEntries(): Promise<void> {
    const errors: unknown[] = [];
    for (const entry of [...this.entries].reverse()) {
      if (entry.state !== "active") continue;
      try {
        await entry.dispose();
        entry.state = "disposed";
      } catch (error) {
        entry.state = "failed";
        errors.push(error);
      }
    }
    if (errors.length > 0) {
      throw new AggregateError(errors, `Runtime resource scope ${this.label} cleanup failed.`);
    }
  }

  private assertCanRegister(): void {
    if (this.disposal !== undefined) {
      throw new Error(`Runtime resource scope ${this.label} is closing.`);
    }
    if (this.transferred) {
      throw new Error(`Runtime resource scope ${this.label} has transferred ownership.`);
    }
    if (this.sealed) {
      throw new Error(`Runtime resource scope ${this.label} is sealed.`);
    }
  }
}
