import { compileBuiltInAgent } from "@pragma/built-in-agents";
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStaticRuntimeResolver } from "@pragma/core";
import { defineRuntimeTestDriver } from "@pragma/core/testing";
import { SKILL_REVISION_EXPERT_REF, STORE_REVISION_EXPERT_REF } from "@pragma/built-in-agents";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createDesktopSkillAgents } from "../capabilities/skill-agents.ts";
import { migrateLegacyRevisionProfile } from "./legacy-revision-profile-migration.ts";
import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function fixture(onChanged?: (ref: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "pragma-revision-profile-migration-"));
  directories.push(root);
  const stateRoot = join(root, "state");
  const profilePath = join(stateRoot, "context-store-revisions", "profile.json");
  await mkdir(join(stateRoot, "context-store-revisions"), { recursive: true });
  // Written by the pre-removal ContextStoreRevisionService.updateProfile implementation.
  await copyFile(new URL("./__fixtures__/revision-profile-v1.json", import.meta.url), profilePath);
  const configPath = join(stateRoot, "system-experts.json");
  const systemExperts = createDesktopSystemExpertRegistry({ configPath, onChanged });
  await systemExperts.initialize();
  return { root, stateRoot, profilePath, configPath, systemExperts };
}

const model = {
  runtimeId: "codex",
  providerId: "openai",
  modelId: "gpt-test",
  thinkingLevel: "high",
};

describe("legacy revision profile retirement", () => {
  it("preserves the historical profile and uses the migrated Skill Expert at the compile boundary", async () => {
    const f = await fixture();
    const source = await readFile(f.profilePath, "utf8");
    await migrateLegacyRevisionProfile(f);
    for (const ref of [STORE_REVISION_EXPERT_REF, SKILL_REVISION_EXPERT_REF]) {
      expect(f.systemExperts.get(ref)?.executionProfile).toEqual({ mode: "pinned", model });
    }
    expect(
      await readFile(join(f.stateRoot, "migration-backups", "revision-profile-v1.json"), "utf8"),
    ).toBe(source);
    expect(await readFile(f.profilePath, "utf8")).toBe(source);
    const systemExperts = createDesktopSystemExpertRegistry({ configPath: f.configPath });
    await systemExperts.initialize();
    const runtimes = createStaticRuntimeResolver({
      defaultRuntimeId: "default",
      runtimes: ["default", "codex"].map((id) =>
        defineRuntimeTestDriver({
          descriptor: { id, kind: "codex-local", displayName: id },
          canUse: () => ({ usable: true }),
          createSession: () => ({}),
          startTurn: () => ({ outputText: "" }),
          mapEvent: () => ({ events: [] }),
        }),
      ),
    });
    const bind = vi.spyOn(runtimes, "bind");
    const agents = createDesktopSkillAgents({
      systemExperts,
      runtimes,
      pragmaHome: f.root,
      missions: {} as Parameters<typeof createDesktopSkillAgents>[0]["missions"],
      runner: {} as Parameters<typeof createDesktopSkillAgents>[0]["runner"],
      project: {} as Parameters<typeof createDesktopSkillAgents>[0]["project"],
      resolveDraftWorkspace: async () => f.root,
    });
    const compile = async () =>
      compileBuiltInAgent(
        await agents.source({
          expertResource: systemExperts.getResource(SKILL_REVISION_EXPERT_REF)!,
          adapterHost: {
            environmentId: "desktop",
            projectRoot: f.root,
            resolveBinding: async (ref) =>
              ref === "binding:pragma.management"
                ? {
                    ref,
                    revision: "1",
                    fingerprint: "e".repeat(64),
                    value: { contribution: { tools: [] } },
                  }
                : undefined,
            resolveArtifact: async () => {
              throw new Error("Unexpected artifact");
            },
            resolveSecret: async () => undefined,
          },
        }),
      );
    const fingerprint = await agents.fingerprint();
    expect((await compile()).rootRuntimeId).toBe("codex");
    expect(bind).toHaveBeenCalledWith({
      runtimeId: "codex",
      modelSelection: {
        model: { providerId: "openai", modelId: "gpt-test" },
        thinkingLevel: "high",
      },
    });
    await systemExperts.reset(SKILL_REVISION_EXPERT_REF);
    await migrateLegacyRevisionProfile({ ...f, systemExperts });
    expect(systemExperts.get(SKILL_REVISION_EXPERT_REF)?.executionProfile.mode).toBe(
      "system-default",
    );
    expect((await compile()).rootRuntimeId).toBe("default");
    expect(await agents.fingerprint()).not.toBe(fingerprint);
  });

  it("replays an interrupted migration while preserving existing Studio customization", async () => {
    let crash = true;
    const f = await fixture(async () => {
      if (crash) {
        crash = false;
        throw new Error("simulated crash after config commit");
      }
    });
    await expect(migrateLegacyRevisionProfile(f)).rejects.toThrow("simulated crash");
    const systemExperts = createDesktopSystemExpertRegistry({ configPath: f.configPath });
    await systemExperts.initialize();
    await migrateLegacyRevisionProfile({ ...f, systemExperts });
    expect(systemExperts.get(SKILL_REVISION_EXPERT_REF)?.executionProfile).toEqual({
      mode: "pinned",
      model,
    });
    const config = await readFile(f.configPath, "utf8");
    await migrateLegacyRevisionProfile({ ...f, systemExperts });
    expect(await readFile(f.configPath, "utf8")).toBe(config);
  });

  it("keeps an explicitly customized Skill Expert ahead of the old shared preference", async () => {
    const f = await fixture();
    const current = f.systemExperts.get(SKILL_REVISION_EXPERT_REF)!;
    await f.systemExperts.update(SKILL_REVISION_EXPERT_REF, {
      name: current.name,
      description: current.description,
      tags: current.tags,
      additionalInstructions: "Use the Studio configuration",
      capabilities: [],
      toolApprovals: {},
      plugins: [],
      contextStoreMounts: [],
      resourceTools: current.resourceTools,
      model: { ...model, modelId: "studio-model" },
    });
    await migrateLegacyRevisionProfile(f);
    expect(f.systemExperts.get(SKILL_REVISION_EXPERT_REF)?.executionProfile).toEqual({
      mode: "pinned",
      model: { ...model, modelId: "studio-model" },
    });
  });

  it("accepts fresh installations and rejects future profiles without altering them", async () => {
    const f = await fixture();
    await rm(f.profilePath);
    await migrateLegacyRevisionProfile(f);
    expect(f.systemExperts.get(SKILL_REVISION_EXPERT_REF)?.customized).toBe(false);
    const future = JSON.stringify({ schemaVersion: "pragma.context-store-revision-profile/v99" });
    await writeFile(f.profilePath, future);
    await expect(migrateLegacyRevisionProfile(f)).rejects.toThrow();
    expect(await readFile(f.profilePath, "utf8")).toBe(future);
  });
});
