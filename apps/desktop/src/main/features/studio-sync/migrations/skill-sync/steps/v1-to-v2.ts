import type { StateMigrationStep } from "@pragma/core";

import { SkillSyncStateV1Schema, type SkillSyncStateV1 } from "../schemas/v1.ts";
import { SkillSyncStateV2Schema } from "../schemas/v2.ts";

export const skillSyncStateV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: SkillSyncStateV1Schema,
  migrate(value) {
    const source = SkillSyncStateV1Schema.parse(value);
    assertNoLegacyBundleIdentity(source);
    return SkillSyncStateV2Schema.parse({
      ...source,
      schemaVersion: "pragma.skill-sync-state/v2",
    });
  },
} satisfies StateMigrationStep;

function assertNoLegacyBundleIdentity(source: SkillSyncStateV1): void {
  const keys = [
    ...Object.keys(source.bases),
    ...Object.keys(source.portableFiles),
    ...Object.keys(source.pendingRemoteActivations),
    ...Object.keys(source.conflicts),
    ...Object.keys(source.errors),
    ...source.ignoredRemote.map((item) => item.syncKey),
  ];
  if (keys.some((key) => key.startsWith("bundle/"))) {
    throw new Error(
      "Legacy Bundle Skill sync identities are unsupported. Reinitialize Skill sync.",
    );
  }
}
