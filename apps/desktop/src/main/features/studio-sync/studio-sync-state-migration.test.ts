import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { StateVersionTooNewError } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  KnowledgeSyncStateV2Schema,
  knowledgeSyncStateMigrationChain,
} from "./migrations/knowledge-sync/index.ts";
import {
  SkillSyncStateV2Schema,
  skillSyncStateMigrationChain,
} from "./migrations/skill-sync/index.ts";
import { readStudioSyncState } from "./studio-sync-state-migration.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Studio sync state migrations", () => {
  it("upgrades the historical Skill fixture and rejects future versions", async () => {
    const source = await fixture("skill-sync");
    const upgraded = skillSyncStateMigrationChain.upgrade(source);

    expect(upgraded).toMatchObject({ fromVersion: 1, toVersion: 2, migrated: true });
    expect(upgraded.value).toMatchObject({
      schemaVersion: "pragma.skill-sync-state/v2",
      sourceKey: source.sourceKey,
      bases: { "capability/0123456789abcdef": "skill-fingerprint" },
    });
    expect(skillSyncStateMigrationChain.upgrade(upgraded.value)).toMatchObject({
      migrated: false,
    });
    expect(() =>
      skillSyncStateMigrationChain.upgrade({
        ...upgraded.value,
        schemaVersion: "pragma.skill-sync-state/v3",
      }),
    ).toThrow(StateVersionTooNewError);
  });

  it("rejects legacy Bundle identities instead of mapping them into Capability ids", async () => {
    const source = await fixture("skill-sync");

    try {
      skillSyncStateMigrationChain.upgrade({
        ...source,
        bases: { "bundle/0123456789abcdef": "skill-fingerprint" },
      });
      throw new Error("Expected the legacy Bundle identity to be rejected.");
    } catch (error) {
      expect(error).toMatchObject({
        cause: expect.objectContaining({
          message: expect.stringContaining("Legacy Bundle Skill sync identities are unsupported"),
        }),
      });
    }
  });

  it("atomically upgrades and backs up the historical knowledge fixture", async () => {
    const root = await temporaryRoot();
    const statePath = join(root, "knowledge-sync-state.json");
    const source = await fixture("knowledge-sync");
    await writeFile(statePath, `${JSON.stringify(source, null, 2)}\n`);

    const migrated = await readStudioSyncState({
      statePath,
      chain: knowledgeSyncStateMigrationChain,
      onMissing: () => KnowledgeSyncStateV2Schema.parse(emptyKnowledgeState()),
      finalizeMigrated: (state) =>
        KnowledgeSyncStateV2Schema.parse({ ...state, sourceKey: "configured-source" }),
    });

    expect(migrated).toMatchObject({
      schemaVersion: "pragma.knowledge-sync-state/v2",
      sourceKey: "configured-source",
      bases: source.bases,
    });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toEqual(migrated);
    expect(await readdir(join(root, "migrations", "backups"))).toHaveLength(1);
    expect(knowledgeSyncStateMigrationChain.upgrade(migrated)).toMatchObject({ migrated: false });
    expect(() =>
      knowledgeSyncStateMigrationChain.upgrade({
        ...migrated,
        schemaVersion: "pragma.knowledge-sync-state/v3",
      }),
    ).toThrow(StateVersionTooNewError);
  });

  it("replays an interrupted migration journal before reading state", async () => {
    const root = await temporaryRoot();
    const statePath = join(root, "skill-sync-state.json");
    const source = await fixture("skill-sync");
    const target = SkillSyncStateV2Schema.parse({
      ...source,
      schemaVersion: "pragma.skill-sync-state/v2",
    });
    await writeFile(statePath, `${JSON.stringify(source, null, 2)}\n`);
    await writeFile(
      `${statePath}.state-migration.json`,
      `${JSON.stringify({
        schemaVersion: "pragma.state-migration/v1",
        resource: { family: "pragma.skill-sync-state", id: basename(statePath) },
        fromVersion: 1,
        toVersion: 2,
        documents: { [basename(statePath)]: target },
      })}\n`,
    );

    await expect(
      readStudioSyncState({
        statePath,
        chain: skillSyncStateMigrationChain,
        onMissing: () => SkillSyncStateV2Schema.parse(emptySkillState()),
        finalizeMigrated: (state) => state,
      }),
    ).resolves.toEqual(target);
    await expect(readFile(`${statePath}.state-migration.json`, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });
});

async function fixture(family: "skill-sync" | "knowledge-sync") {
  const path = join(import.meta.dirname, "migrations", family, "fixtures", "v1.json");
  return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-studio-sync-migration-"));
  roots.push(root);
  return root;
}

function emptySkillState() {
  return {
    schemaVersion: "pragma.skill-sync-state/v2",
    bases: {},
    portableFiles: {},
    pendingRemoteActivations: {},
    ignoredRemote: [],
    conflicts: {},
    errors: {},
  };
}

function emptyKnowledgeState() {
  return {
    schemaVersion: "pragma.knowledge-sync-state/v2",
    bases: {},
    ignoredRemote: [],
    conflicts: {},
  };
}
