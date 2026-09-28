/** Fair, cancellation-aware admission for the optional attention provider. */
export function createMemoryAttentionRequestLimiter() {
  let active = 0;
  const queue: { signal: AbortSignal; grant: () => void }[] = [];
  const acquire = async (signal: AbortSignal) => {
    signal.throwIfAborted();
    if (active < 2) {
      active++;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = {
        signal,
        grant: () => {
          signal.removeEventListener("abort", abort);
          resolve();
        },
      };
      const abort = () => {
        const index = queue.indexOf(waiter);
        if (index >= 0) queue.splice(index, 1);
        reject(signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      queue.push(waiter);
    });
  };
  return async <T>(signal: AbortSignal, operation: () => Promise<T>): Promise<T> => {
    await acquire(signal);
    try {
      signal.throwIfAborted();
      return await operation();
    } finally {
      const next = queue.shift();
      // Transfer the reserved slot before waking a waiter; newcomers cannot steal it.
      if (next === undefined) active--;
      else next.grant();
    }
  };
}
