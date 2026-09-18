import type { MissionSummary } from "../../../../shared/contracts/index.ts";

/** A missing rail entry can still have a valid, independently accessible detail. */
export async function resolveUnlistedMissionSelection(input: {
  readonly id: string;
  readonly getSource: (id: string) => Promise<MissionSummary["source"]>;
  readonly isCurrent: () => boolean;
}): Promise<"detail" | "fallback" | "deleted" | "stale"> {
  try {
    const source = await input.getSource(input.id);
    if (!input.isCurrent()) return "stale";
    return source.type === "internal" ? "detail" : "fallback";
  } catch (error) {
    if (!input.isCurrent()) return "stale";
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "mission_not_found"
    )
      return "deleted";
    throw error;
  }
}
