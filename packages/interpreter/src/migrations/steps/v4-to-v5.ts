import { PragmaResourceSchema } from "../../ast/pragma-dsl.schema.ts";
import { PragmaV4SemanticResourceSchema } from "../schemas/v4.ts";
import { PragmaDslMigrationError, type PragmaDslMigrationStep } from "../types.ts";

export const pragmaDslV4ToV5Step = {
  fromApiVersion: "pragma/v4",
  toApiVersion: "pragma/v5",
  migrate(project) {
    return { ...project, resources: project.resources.map(migratePragmaV4ResourceToCurrent) };
  },
} satisfies PragmaDslMigrationStep;

export function migratePragmaV4ResourceToCurrent(resource: unknown) {
  const historical = PragmaV4SemanticResourceSchema.safeParse(resource);
  if (!historical.success) {
    throw new PragmaDslMigrationError(
      "invalid_legacy_project",
      "Pragma v4 project contains an invalid semantic resource.",
      { cause: historical.error },
    );
  }
  const copy = structuredClone(historical.data) as Record<string, unknown>;
  copy["apiVersion"] = "pragma/v5";
  if (copy["kind"] === "ExpertTeam") {
    const spec = copy["spec"] as Record<string, unknown>;
    const delegation = spec["delegation"] as Record<string, unknown>;
    const coordinator = (spec["coordinator"] as { ref: string }).ref.slice("expert:".length);
    const legacyAllow = delegation["allow"] as Record<string, unknown> | undefined;
    const spawn =
      legacyAllow === undefined
        ? undefined
        : Object.fromEntries(
            Object.entries(legacyAllow).filter(([source]) => source !== coordinator),
          );
    delete delegation["allow"];
    delegation["permissions"] = {
      ...(spawn === undefined || Object.keys(spawn).length === 0 ? {} : { spawn }),
      interact: {},
    };
  }
  const parsed = PragmaResourceSchema.safeParse(copy);
  if (!parsed.success) {
    throw new PragmaDslMigrationError(
      "invalid_migrated_project",
      `Migrated Pragma v4 ${historical.data.kind} is not valid pragma/v5.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
