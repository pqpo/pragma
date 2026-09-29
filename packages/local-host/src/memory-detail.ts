import { defaultRuntimeTokenCounter } from "@pragma/core";
import {
  projectMemory,
  projectionHash,
  selectedMemoryText,
  type MemoryAttentionCandidate,
  type MemorySegment,
  type RetrievalRecord,
} from "@pragma/memory";

/** Keep the exact recall anchors before adding bounded surrounding context. */
export function memoryDetailSegments(
  source: RetrievalRecord,
  selectedPaths: MemoryAttentionCandidate["selectedPaths"],
): MemorySegment[] {
  const selected: MemorySegment[] = [];
  for (const path of selectedPaths ?? []) {
    const text = selectedMemoryText(source, path.fieldPath, path.start, path.end);
    if (text === undefined || projectionHash(text) !== path.textHash) continue;
    const segmentId = `${path.fieldPath}:${path.start}:${path.end}`;
    if (!selected.some((segment) => segment.segmentId === segmentId))
      selected.push({ ...path, segmentId, text });
  }
  const projected = projectMemory(source, 600);
  const anchors = projected
    .map((segment, index) =>
      selected.some(
        (anchor) =>
          anchor.fieldPath === segment.fieldPath &&
          anchor.start < segment.end &&
          segment.start < anchor.end,
      )
        ? index
        : -1,
    )
    .filter((index) => index >= 0);
  const surrounding = projected
    .map((segment, index) => ({ segment, index }))
    .filter(({ index }) => !anchors.includes(index))
    .sort((a, b) => {
      if (a.segment.fieldPath === "overview" && b.segment.fieldPath !== "overview") return -1;
      if (b.segment.fieldPath === "overview" && a.segment.fieldPath !== "overview") return 1;
      const distance = (index: number) =>
        anchors.length === 0
          ? index
          : Math.min(...anchors.map((anchor) => Math.abs(anchor - index)));
      return distance(a.index) - distance(b.index) || a.index - b.index;
    });
  for (const { segment } of surrounding) {
    if (selected.length >= 6) break;
    const summary = [...selected, segment].map((value) => value.text).join("\n");
    if (defaultRuntimeTokenCounter.countText(summary).tokens <= 3_600) selected.push(segment);
  }
  return selected;
}
