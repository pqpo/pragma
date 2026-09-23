import type { ExecutionOutputItem } from "@pragma/shared";

const DEFAULT_FLUSH_INTERVAL_MS = 50;
const DEFAULT_MAX_BUFFERED_CHARACTERS = 64 * 1_024;

export interface MissionOutputCoalescerStats {
  readonly rawItems: number;
  readonly emittedItems: number;
  readonly coalescedItems: number;
  readonly maxBufferedCharacters: number;
}

export interface MissionOutputCoalescer {
  push(item: ExecutionOutputItem): void;
  flush(): void;
  close(): void;
  stats(): MissionOutputCoalescerStats;
}

export function createMissionOutputCoalescer(options: {
  readonly emit: (item: ExecutionOutputItem) => void;
  readonly flushIntervalMs?: number | undefined;
  readonly maxBufferedCharacters?: number | undefined;
}): MissionOutputCoalescer {
  const flushIntervalMs = options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;
  const bufferedCharacterLimit = options.maxBufferedCharacters ?? DEFAULT_MAX_BUFFERED_CHARACTERS;
  let activeSegmentKey: string | undefined;
  let buffered: ExecutionOutputItem | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  let rawItems = 0;
  let emittedItems = 0;
  let coalescedItems = 0;
  let maxBufferedCharacters = 0;

  const cancelTimer = (): void => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const emit = (item: ExecutionOutputItem): void => {
    emittedItems += 1;
    options.emit(item);
  };
  const flush = (): void => {
    cancelTimer();
    if (buffered === undefined) return;
    const item = buffered;
    buffered = undefined;
    emit(item);
  };
  const schedule = (): void => {
    if (timer !== undefined || buffered === undefined) return;
    timer = setTimeout(flush, flushIntervalMs);
    timer.unref?.();
  };

  return {
    push(item) {
      if (closed) return;
      rawItems += 1;
      const key = coalescibleOutputKey(item);
      if (key === undefined) {
        flush();
        activeSegmentKey = undefined;
        emit(item);
        return;
      }
      if (activeSegmentKey !== key) {
        flush();
        activeSegmentKey = key;
        // Preserve first-token latency for every new visible stream segment.
        emit(item);
        return;
      }
      if (buffered === undefined) {
        buffered = item;
      } else if (coalescibleOutputKey(buffered) === key) {
        buffered = {
          ...buffered,
          sourceEventId: item.sourceEventId,
          ...(item.cursor === undefined ? {} : { cursor: item.cursor }),
          delta: `${buffered.delta ?? ""}${item.delta ?? ""}`,
          occurredAt: item.occurredAt,
        };
        coalescedItems += 1;
      } else {
        flush();
        buffered = item;
      }
      maxBufferedCharacters = Math.max(maxBufferedCharacters, buffered.delta?.length ?? 0);
      if ((buffered.delta?.length ?? 0) >= bufferedCharacterLimit) flush();
      else schedule();
    },
    flush,
    close() {
      if (closed) return;
      closed = true;
      flush();
    },
    stats: () => ({ rawItems, emittedItems, coalescedItems, maxBufferedCharacters }),
  };
}

function coalescibleOutputKey(item: ExecutionOutputItem): string | undefined {
  if (item.delta === undefined || (item.channel !== "message" && item.channel !== "thought")) {
    return undefined;
  }
  return JSON.stringify([
    item.executionId,
    item.invocationId,
    item.runId,
    item.channel,
    item.source.kind,
    item.source.runId,
    item.source.parentRunId,
    item.source.sessionId,
    item.source.parentSessionId,
    item.source.agentId,
    item.source.agentType,
    item.source.toolCallId,
    item.source.path,
  ]);
}
