import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
  upgradeKnowledgeRepositoryManifest,
  upgradeKnowledgeStoreManifest,
  upgradeSkillManifest,
  upgradeSkillRepositoryManifest,
} from "./asset-git-protocol-migrations.ts";

async function historical(name: string): Promise<unknown> {
  return parse(await readFile(new URL(`./test-fixtures/${name}.yaml`, import.meta.url), "utf8"));
}

describe("environment sync asset Git protocol upgrades", () => {
  it("upgrades manifests written by the historical knowledge provider", async () => {
    const root = await historical("knowledge-root-v1");
    const old = await historical("knowledge-store-v1");
    const currentRoot = upgradeKnowledgeRepositoryManifest(root);
    expect(currentRoot).toEqual({
      schemaVersion: "pragma.knowledge-sync/v2",
    });
    expect(upgradeKnowledgeRepositoryManifest(currentRoot)).toEqual(currentRoot);
    expect(() =>
      upgradeKnowledgeRepositoryManifest({ schemaVersion: "pragma.knowledge-sync/v3" }),
    ).toThrow();
    const current = upgradeKnowledgeStoreManifest(old);
    expect(current.schemaVersion).toBe("pragma.knowledge-sync-store/v2");
    expect(upgradeKnowledgeStoreManifest(current)).toEqual(current);
    expect(() =>
      upgradeKnowledgeStoreManifest({
        ...current,
        schemaVersion: "pragma.knowledge-sync-store/v3",
      }),
    ).toThrow();
  });

  it("upgrades manifests written by both historical Skill providers", async () => {
    const rootV1 = await historical("skill-root-v1");
    const skillV1 = await historical("skill-store-v1");
    const rootV2 = await historical("skill-root-v2");
    const skillV2 = await historical("skill-store-v2");
    expect(upgradeSkillRepositoryManifest(rootV1)).toEqual({
      schemaVersion: "pragma.skill-sync/v3",
    });
    const currentRoot = upgradeSkillRepositoryManifest(rootV2);
    expect(currentRoot).toEqual({
      schemaVersion: "pragma.skill-sync/v3",
    });
    expect(upgradeSkillRepositoryManifest(currentRoot)).toEqual(currentRoot);
    expect(() =>
      upgradeSkillRepositoryManifest({ schemaVersion: "pragma.skill-sync/v4" }),
    ).toThrow();
    expect(upgradeSkillManifest(skillV2).schemaVersion).toBe("pragma.skill-sync-skill/v3");
    const current = upgradeSkillManifest(skillV1);
    expect(current.schemaVersion).toBe("pragma.skill-sync-skill/v3");
    expect(upgradeSkillManifest(current)).toEqual(current);
    expect(() =>
      upgradeSkillManifest({ ...current, schemaVersion: "pragma.skill-sync-skill/v4" }),
    ).toThrow();
  });
});
