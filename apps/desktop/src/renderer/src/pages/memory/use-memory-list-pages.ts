import { useCallback, useEffect, useRef, useState } from "react";

export const MEMORY_LIST_PAGE_SIZE = 30;

/** Refresh the loaded window and append pages without allowing stale requests to replace it. */
export function useMemoryListPages<T>(options: {
  enabled: boolean;
  fetchPage: (offset: number, limit: number) => Promise<readonly T[]>;
  key: (item: T) => string;
  pollInterval?: number;
}) {
  const { enabled, fetchPage, key, pollInterval } = options;
  const [items, setItems] = useState<readonly T[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState(false);
  const generation = useRef(0);
  const loadedPages = useRef(0);
  const failedAppend = useRef(true);
  const pending = useRef<Promise<void> | undefined>(undefined);

  const request = useCallback(
    (append: boolean): Promise<void> => {
      if (!enabled) return Promise.resolve();
      if (pending.current !== undefined) return pending.current;
      const current = generation.current;
      const start = append ? loadedPages.current : 0;
      const count = append ? 1 : Math.max(1, loadedPages.current);
      setLoading(true);
      const operation = Promise.resolve().then(async () => {
        try {
          const pages = await Promise.all(
            Array.from({ length: count }, (_, index) =>
              fetchPage((start + index) * MEMORY_LIST_PAGE_SIZE, MEMORY_LIST_PAGE_SIZE + 1),
            ),
          );
          if (current !== generation.current) return;
          const records = pages.flatMap((page) => page.slice(0, MEMORY_LIST_PAGE_SIZE));
          setItems((previous) => [
            ...new Map(
              [...(append ? previous : []), ...records].map((item) => [key(item), item]),
            ).values(),
          ]);
          loadedPages.current = start + pages.length;
          setHasMore(pages.at(-1)!.length > MEMORY_LIST_PAGE_SIZE);
          setError(false);
        } catch {
          if (current === generation.current) {
            failedAppend.current = append;
            setError(true);
          }
        } finally {
          if (current === generation.current) {
            pending.current = undefined;
            setLoading(false);
          }
        }
      });
      pending.current = operation;
      return operation;
    },
    [enabled, fetchPage, key],
  );
  const refresh = useCallback(async () => {
    const current = generation.current;
    await pending.current;
    if (current === generation.current) await request(false);
  }, [request]);
  const loadMore = useCallback(
    () => request(error ? failedAppend.current : true),
    [error, request],
  );

  useEffect(() => {
    generation.current += 1;
    pending.current = undefined;
    loadedPages.current = 0;
    setItems([]);
    setError(false);
    setHasMore(false);
    setLoading(enabled);
    if (!enabled) return;
    const timer = setTimeout(() => void refresh(), 120);
    return () => {
      clearTimeout(timer);
      generation.current += 1;
      pending.current = undefined;
    };
  }, [enabled, refresh]);

  useEffect(() => {
    if (!enabled || pollInterval === undefined) return;
    const timer = setInterval(() => void request(false), pollInterval);
    return () => clearInterval(timer);
  }, [enabled, pollInterval, request]);

  return { items, loading, hasMore, error, refresh, loadMore };
}
