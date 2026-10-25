import { PragmaForwardCompatibleResourceSchema } from "../../ast/pragma-dsl.schema.ts";
import { PragmaForwardCompatibleResourceSchema as HistoricalResourceSchema } from "../schemas/v5.ts";
import type { PragmaDslMigrationStep } from "../types.ts";
export function migratePragmaV5ResourceToCurrent(input: unknown) {
  const legacy = HistoricalResourceSchema.parse(input);
  return PragmaForwardCompatibleResourceSchema.parse({ ...legacy, apiVersion: "pragma/v6" });
}
export const pragmaDslV5ToV6Step = {
  fromApiVersion: "pragma/v5",
  toApiVersion: "pragma/v6",
  migrate(project) {
    return { ...project, resources: project.resources.map(migratePragmaV5ResourceToCurrent) };
  },
} satisfies PragmaDslMigrationStep;
