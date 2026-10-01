import type { createMissionDelivery } from "./mission-delivery.ts";

type MissionDelivery = Awaited<ReturnType<typeof createMissionDelivery>>;

/** Retry only this optional consumer; unavailable custody still fences Feed retention. */
export function createMissionDeliveryRecovery(input: {
  readonly delivery: { current: MissionDelivery | undefined };
  readonly create: () => Promise<MissionDelivery>;
  readonly onUnavailable: (error: unknown) => void;
  readonly onRecovered: () => void;
}) {
  let started = false;
  let closed = false;
  let attempts = 0;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const initialize = (): Promise<void> => {
    if (closed || input.delivery.current !== undefined) return Promise.resolve();
    if (running !== undefined) return running;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const operation = (async () => {
      try {
        const delivery = await input.create();
        if (closed) {
          await delivery.close();
          return;
        }
        input.delivery.current = delivery;
        attempts = 0;
        input.onRecovered();
        if (started) delivery.start();
      } catch (error) {
        attempts += 1;
        if (!closed) input.onUnavailable(error);
      }
    })().finally(() => {
      if (running === operation) running = undefined;
      if (started && !closed && input.delivery.current === undefined) {
        timer = setTimeout(
          () => void initialize(),
          Math.min(60_000, 1000 * 2 ** Math.min(attempts - 1, 6)),
        );
        timer.unref();
      }
    });
    running = operation;
    return operation;
  };

  return {
    initialize,
    start() {
      if (closed || started) return;
      started = true;
      if (input.delivery.current !== undefined) input.delivery.current.start();
      else void initialize();
    },
    async close() {
      closed = true;
      started = false;
      if (timer !== undefined) clearTimeout(timer);
      await running;
      await input.delivery.current?.close();
    },
  };
}
