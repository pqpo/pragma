import type { StateMigrationStep } from "@pragma/core";

import { SkillSyncStateV1Schema } from "../schemas/v1.ts";
import { SkillSyncStateV2Schema } from "../schemas/v2.ts";

export const skillSyncStateV1ToV2Step = {
  fromVersion: 1,
  toVersion: 2,
  inputSchema: SkillSyncStateV1Schema,
  migrate(value) {
    const source = SkillSyncStateV1Schema.parse(value);
    return SkillSyncStateV2Schema.parse({
      ...source,
      schemaVersion: "pragma.skill-sync-state/v2",
      bases: migrateKeys(source.bases),
      portableFiles: migrateKeys(source.portableFiles),
      pendingRemoteActivations: migrateKeys(source.pendingRemoteActivations),
      conflicts: migrateKeys(source.conflicts),
      errors: migrateKeys(source.errors),
      ignoredRemote: source.ignoredRemote.map((item) => ({
        ...item,
        syncKey: migrateKey(item.syncKey),
      })),
    });
  },
} satisfies StateMigrationStep;

function migrateKeys<T>(source: Readonly<Record<string, T>>): Record<string, T> {
  const target: Record<string, T> = {};
  for (const [key, value] of Object.entries(source)) {
    const migrated = migrateKey(key);
    if (target[migrated] !== undefined) {
      throw new Error(`Skill sync state contains colliding identities for ${migrated}.`);
    }
    target[migrated] = value;
  }
  return target;
}

function migrateKey(key: string): string {
  return key.startsWith("bundle/") ? `capability/${key.slice("bundle/".length)}` : key;
}
