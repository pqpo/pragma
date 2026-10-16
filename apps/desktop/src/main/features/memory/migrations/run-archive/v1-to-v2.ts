import { MemoryExtractionRunV1Schema } from "./v1.ts";
import { DesktopMemoryExtractionRunSchema } from "../../../../../shared/contracts/memory.ts";

export function migrateMemoryExtractionRunV1ToV2(input: unknown) {
  const previous = MemoryExtractionRunV1Schema.parse(input);
  return DesktopMemoryExtractionRunSchema.parse({
    ...previous,
    schemaVersion: "pragma.desktop-memory-extraction-run/v2",
    continuations: 0,
  });
}
