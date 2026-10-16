/** Reciprocal-rank fusion shared by Context Store and extraction retrieval. */
export function fuseMemoryRanks<T>(
  groups: readonly (readonly T[])[],
  key: (item: T) => string,
): T[] {
  const combined = new Map<string, { value: T; score: number }>();
  for (const group of groups) {
    const seen = new Set<string>();
    group.forEach((value, index) => {
      const id = key(value);
      if (seen.has(id)) return;
      seen.add(id);
      const previous = combined.get(id);
      combined.set(id, {
        value: previous?.value ?? value,
        score: (previous?.score ?? 0) + 1 / (60 + index + 1),
      });
    });
  }
  return [...combined.entries()]
    .sort(([a, left], [b, right]) => right.score - left.score || a.localeCompare(b))
    .map(([, item]) => item.value);
}
