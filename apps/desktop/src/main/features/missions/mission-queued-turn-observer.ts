import type { MutableExecution } from "@pragma/core";

/** Register before reading state so a fast queued turn cannot start in the subscription gap. */
export async function observeMissionQueuedTurn(
  execution: Pick<MutableExecution, "getState" | "subscribeEvents">,
  onStarted: () => Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  const subscription = await execution.subscribeEvents({ scope: { kind: "root" } });
  const abort = (): void => {
    void subscription.close().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  try {
    if (signal?.aborted) return;
    const state = await execution.getState();
    if (signal?.aborted) return;
    if (state.status === "cancelled" || state.status === "interrupted") return;
    if (state.status !== "queued") {
      await onStarted();
      return;
    }
    for await (const event of subscription) {
      if (signal?.aborted) return;
      if (
        event.type === "execution.cancelled" ||
        event.type === "execution.interrupted" ||
        event.type === "execution.failed" ||
        event.type === "execution.succeeded"
      )
        return;
      if (event.type === "execution.started") {
        await onStarted();
        return;
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
    await subscription.close();
  }
}
