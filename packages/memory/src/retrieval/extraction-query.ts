import type { MemorySubjectRef } from "@pragma/shared";
import type { MemoryRecallScope } from "../pipeline/memory-module.ts";

/** All source scopes must authorize a result before ranking or pagination. */
export interface ExtractionRecallFilter {
  readonly scopes: readonly MemoryRecallScope[];
  readonly subjects: readonly MemorySubjectRef[];
}
export interface ExtractionCatalogQuery {
  readonly filter: ExtractionRecallFilter;
  readonly query?: string | undefined;
  readonly afterId?: string | undefined;
  readonly limit?: number | undefined;
}
export function extractionSubjectPredicate(alias: string, subjects: readonly MemorySubjectRef[]) {
  return {
    sql: `NOT EXISTS (SELECT 1 FROM json_each(${alias}.record_json, '$.subjectRefs') AS subject
      WHERE NOT EXISTS (SELECT 1 FROM json_each(?) AS permitted
        WHERE json_extract(permitted.value, '$.type') = json_extract(subject.value, '$.type')
          AND json_extract(permitted.value, '$.id') = json_extract(subject.value, '$.id')))`,
    parameters: [JSON.stringify(subjects)],
  };
}
