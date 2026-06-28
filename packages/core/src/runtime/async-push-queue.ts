export class AsyncPushQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = [];
  private readonly waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  private closed = false;
  private failure: unknown;

  push(value: T): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve({ value, done: false });
      return;
    }

    this.values.push(value);
  }

  close(): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.closed = true;
    this.resolveWaiters({ value: undefined, done: true });
  }

  fail(error: unknown): void {
    if (this.closed || this.failure !== undefined) {
      return;
    }

    this.failure = error;
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(error);
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => this.next(),
    };
  }

  private next(): Promise<IteratorResult<T>> {
    if (this.values.length > 0) {
      return Promise.resolve({ value: this.values.shift() as T, done: false });
    }

    if (this.failure !== undefined) {
      return Promise.reject(this.failure);
    }

    if (this.closed) {
      return Promise.resolve({ value: undefined, done: true });
    }

    return new Promise<IteratorResult<T>>((resolve, reject) => {
      this.waiters.push({ resolve, reject });
    });
  }

  private resolveWaiters(result: IteratorResult<T>): void {
    const waiters = this.waiters.splice(0);
    for (const waiter of waiters) {
      waiter.resolve(result);
    }
  }
}
