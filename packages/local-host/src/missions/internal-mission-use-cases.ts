import type { Mission } from "@pragma/shared";

/** Observe durable terminal facts without dispatching another Runtime turn. */
export async function waitForInternalMissionTerminal(input: {
  readonly getMission: (id: string) => Promise<Mission>;
  readonly missionId: string;
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMessage: string;
  readonly timeoutMs?: number | undefined;
  readonly pollIntervalMs?: number | undefined;
}): Promise<Mission> {
  const deadline = Date.now() + (input.timeoutMs ?? 10 * 60_000);
  while (Date.now() < deadline) {
    input.signal?.throwIfAborted();
    const mission = await input.getMission(input.missionId);
    input.signal?.throwIfAborted();
    if (
      mission.execution !== undefined &&
      ["succeeded", "failed", "cancelled"].includes(mission.execution.status)
    )
      return mission;
    await waitForInternalMissionRetry(input.pollIntervalMs ?? 200, input.signal);
  }
  throw new Error(input.timeoutMessage);
}

/** Abort promptly and release the listener on both completion and cancellation. */
export async function waitForInternalMissionRetry(
  delayMs: number,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/** Call only after the consumer has taken custody of any required history. */
export async function cleanupInternalMission(input: {
  readonly missionId: string;
  readonly deleteMission: (id: string) => Promise<unknown>;
  readonly interruptMission: (id: string) => Promise<unknown>;
}): Promise<boolean> {
  try {
    await input.deleteMission(input.missionId);
    return true;
  } catch {
    await input.interruptMission(input.missionId).catch(() => undefined);
    return await input
      .deleteMission(input.missionId)
      .then(() => true)
      .catch(() => false);
  }
}
