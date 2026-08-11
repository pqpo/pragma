import {
  DEFAULT_PRAGMA_EXPERT_AVATAR_ID,
  DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID,
} from "@pragma/shared";

import { PragmaResourceSchema } from "../../ast/pragma-dsl.schema.ts";
import { PragmaV3SemanticResourceSchema } from "../schemas/v3.ts";
import { PragmaDslMigrationError, type PragmaDslMigrationStep } from "../types.ts";

export const pragmaDslV3ToV4Step = {
  fromApiVersion: "pragma/v3",
  toApiVersion: "pragma/v4",
  migrate(project) {
    const resources = project.resources.map(migratePragmaV3ResourceToCurrent);
    return { ...project, resources };
  },
} satisfies PragmaDslMigrationStep;

export function migratePragmaV3ResourceToCurrent(resource: unknown) {
  const historical = PragmaV3SemanticResourceSchema.safeParse(resource);
  if (!historical.success) {
    throw new PragmaDslMigrationError(
      "invalid_legacy_project",
      "Pragma v3 project contains an invalid semantic resource.",
      { cause: historical.error },
    );
  }
  const copy = structuredClone(historical.data) as Record<string, unknown>;
  copy["apiVersion"] = "pragma/v4";
  if (copy["kind"] === "Expert" || copy["kind"] === "ExpertTeam") {
    const metadata = copy["metadata"] as Record<string, unknown>;
    metadata["avatarId"] =
      copy["kind"] === "Expert"
        ? DEFAULT_PRAGMA_EXPERT_AVATAR_ID
        : DEFAULT_PRAGMA_EXPERT_TEAM_AVATAR_ID;
  }
  const parsed = PragmaResourceSchema.safeParse(copy);
  if (!parsed.success) {
    throw new PragmaDslMigrationError(
      "invalid_migrated_project",
      `Migrated Pragma v3 ${historical.data.kind} is not valid pragma/v4.`,
      { cause: parsed.error },
    );
  }
  return parsed.data;
}
