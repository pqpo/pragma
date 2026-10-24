import { SystemExpertCustomizationConfigV9Schema } from "../schemas/v9.ts";
export function migrateV9ToV10(input: unknown) {
  const legacy = SystemExpertCustomizationConfigV9Schema.parse(input);
  return { ...legacy, schemaVersion: 10 as const };
}
