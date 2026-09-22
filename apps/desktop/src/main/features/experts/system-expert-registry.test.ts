import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  BUILT_IN_AGENT_REFS,
  BUILT_IN_PRAGMA_REF,
  SKILL_REVISION_EXPERT_REF,
  STORE_REVISION_EXPERT_REF,
} from "@pragma/built-in-agents";

import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";
import { desktopCapabilityBindingRef } from "../../platform/bindings/desktop-binding-ref.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DesktopSystemExpertRegistry", () => {
  it("exposes the default Agent as a read-only, system-default Expert and mission executor", () => {
    const registry = createDesktopSystemExpertRegistry();
    const definition = registry.get(BUILT_IN_PRAGMA_REF);

    expect(definition).toMatchObject({
      ref: BUILT_IN_PRAGMA_REF,
      id: "0000000000pragma",
      name: "Pragma",
      description: expect.stringContaining("general-purpose Agent"),
      origin: "built-in",
      readOnly: true,
      customized: false,
      executionProfile: { mode: "system-default" },
    });
    expect(registry.list()).toContainEqual(
      expect.objectContaining({ ref: BUILT_IN_PRAGMA_REF, readOnly: true }),
    );
    expect(registry.listExecutors()).toContainEqual(
      expect.objectContaining({
        ref: BUILT_IN_PRAGMA_REF,
        kind: "expert",
        origin: "built-in",
        readOnly: true,
        customized: false,
      }),
    );
    expect(registry.isReservedRef(BUILT_IN_PRAGMA_REF)).toBe(true);
    expect(registry.isReservedId("0000000000pragma")).toBe(true);
    expect(registry.fingerprint(BUILT_IN_PRAGMA_REF)).toMatch(/^[a-f0-9]{64}$/);
    expect(
      registry.get(BUILT_IN_PRAGMA_REF)?.resourceTools.map((binding) => binding.tool?.name),
    ).toEqual(["call_store_revision_agent", "call_skill_revision_agent"]);
  });

  it("exposes Store and Skill Revision while keeping the other managed identities internal", async () => {
    const registry = createDesktopSystemExpertRegistry();
    expect(registry.get(STORE_REVISION_EXPERT_REF)).toMatchObject({
      ref: STORE_REVISION_EXPERT_REF,
      name: "Store Revision Agent",
      opaqueCapabilities: [expect.objectContaining({ ref: "capability:0000000000manage" })],
    });
    expect(registry.getExecutor(STORE_REVISION_EXPERT_REF)).toMatchObject({
      ref: STORE_REVISION_EXPERT_REF,
      kind: "expert",
    });
    expect(registry.get(SKILL_REVISION_EXPERT_REF)).toMatchObject({
      ref: SKILL_REVISION_EXPERT_REF,
      name: "Skill Revision Agent",
      avatarId: "pragma.avatar.expert.07",
    });
    expect(registry.getExecutor(SKILL_REVISION_EXPERT_REF)).toMatchObject({
      ref: SKILL_REVISION_EXPERT_REF,
      kind: "expert",
    });
    const managedRefs = BUILT_IN_AGENT_REFS.filter(
      (ref) =>
        ref !== BUILT_IN_PRAGMA_REF &&
        ref !== STORE_REVISION_EXPERT_REF &&
        ref !== SKILL_REVISION_EXPERT_REF,
    );

    expect(managedRefs).toHaveLength(2);
    for (const ref of managedRefs) {
      expect(registry.isReservedRef(ref)).toBe(true);
      expect(registry.isReservedId(ref.slice("expert:".length))).toBe(true);
      expect(registry.get(ref)).toBeUndefined();
      expect(registry.getExecutor(ref)).toBeUndefined();
      await expect(
        registry.update(ref, {
          name: "Managed",
          description: "Managed system Agent.",
          tags: [],
          additionalInstructions: "",
          capabilities: [],
          toolApprovals: {},
          plugins: [],
          contextStoreMounts: [],
          resourceTools: [],
        }),
      ).rejects.toThrow("Built-in Expert not found");
    }
  });

  it("invalidates the Pragma fingerprint when a referenced built-in Agent changes", async () => {
    const registry = createDesktopSystemExpertRegistry();
    const before = registry.fingerprint(BUILT_IN_PRAGMA_REF);
    const storeRevision = registry.get(STORE_REVISION_EXPERT_REF)!;

    await registry.update(STORE_REVISION_EXPERT_REF, {
      name: "Customized Store Revision",
      description: storeRevision.description,
      tags: storeRevision.tags,
      additionalInstructions: storeRevision.additionalInstructions,
      capabilities: storeRevision.capabilities,
      toolApprovals: storeRevision.toolApprovals,
      plugins: storeRevision.plugins,
      contextStoreMounts: storeRevision.contextStoreMounts,
      resourceTools: storeRevision.resourceTools,
    });

    expect(registry.fingerprint(BUILT_IN_PRAGMA_REF)).not.toBe(before);
  });

  it("persists an editable override and resets to the shipped definition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-system-experts-"));
    directories.push(directory);
    const configPath = join(directory, "system-experts.json");
    const registry = createDesktopSystemExpertRegistry({ configPath });
    await registry.initialize();
    const original = registry.get(BUILT_IN_PRAGMA_REF)!;
    const originalFingerprint = registry.fingerprint(BUILT_IN_PRAGMA_REF);
    const capabilityId = "11111111-1111-4111-8111-111111111111";
    const contextStoreId = "22222222-2222-4222-8222-222222222222";

    const customized = await registry.update(BUILT_IN_PRAGMA_REF, {
      avatarId: "pragma.avatar.expert.reviewer",
      name: "My Pragma",
      description: "A customized built-in Pragma Agent.",
      tags: ["builtin", "customized"],
      additionalInstructions: "Prefer concise plans and confirm destructive operations.",
      model: {
        runtimeId: "codex",
        providerId: "openai",
        modelId: "gpt-5.6",
        thinkingLevel: "high",
      },
      capabilities: [{ kind: "tools", capabilityId, toolNames: ["search_docs"] }],
      toolApprovals: { mcp_docs_search_docs: "required" },
      plugins: [],
      contextStoreMounts: [{ storeId: contextStoreId, enabled: true, priority: 0 }],
      resourceTools: [],
    });

    expect(customized).toMatchObject({
      name: "My Pragma",
      avatarId: "pragma.avatar.expert.reviewer",
      customized: true,
      revision: 2,
      scope: original.scope,
      instructions: original.instructions,
      additionalInstructions: "Prefer concise plans and confirm destructive operations.",
      executionProfile: { mode: "pinned", model: { runtimeId: "codex", modelId: "gpt-5.6" } },
      resourceTools: [],
    });
    expect(registry.listExecutors()).toContainEqual(
      expect.objectContaining({
        ref: BUILT_IN_PRAGMA_REF,
        name: "My Pragma",
        customized: true,
      }),
    );
    expect(registry.getResource(BUILT_IN_PRAGMA_REF)?.spec.instructions).toContain(
      original.instructions,
    );
    expect(registry.getResource(BUILT_IN_PRAGMA_REF)?.spec.instructions).toContain(
      "User customization:\nPrefer concise plans",
    );
    expect(registry.getResource(BUILT_IN_PRAGMA_REF)?.spec.capabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ tools: ["search_docs"] })]),
    );
    expect(registry.getAdditionalResources(BUILT_IN_PRAGMA_REF)).toHaveLength(2);
    expect(registry.fingerprint(BUILT_IN_PRAGMA_REF)).not.toBe(originalFingerprint);

    await expect(registry.validateCapabilityCompatibility(capabilityId, [])).rejects.toMatchObject({
      code: "capability_incompatible",
    });
    expect(registry.get(BUILT_IN_PRAGMA_REF)).toMatchObject({
      revision: 2,
      capabilities: [{ capabilityId }],
    });

    await expect(
      registry.validateCapabilityCompatibility(capabilityId, ["search_docs"]),
    ).resolves.toBeUndefined();
    expect(registry.get(BUILT_IN_PRAGMA_REF)).toMatchObject({
      revision: 2,
      capabilities: [{ capabilityId }],
    });
    expect(
      registry
        .getAdditionalResources(BUILT_IN_PRAGMA_REF)
        .find((resource) => resource.kind === "Capability"),
    ).toMatchObject({ spec: { binding: desktopCapabilityBindingRef(capabilityId) } });

    const reloaded = createDesktopSystemExpertRegistry({ configPath });
    await reloaded.initialize();
    expect(reloaded.get(BUILT_IN_PRAGMA_REF)).toMatchObject({
      name: "My Pragma",
      avatarId: "pragma.avatar.expert.reviewer",
      customized: true,
      additionalInstructions: "Prefer concise plans and confirm destructive operations.",
    });

    const reset = await reloaded.reset(BUILT_IN_PRAGMA_REF);
    expect(reset).toMatchObject({
      name: original.name,
      avatarId: "pragma.avatar.expert.default",
      instructions: original.instructions,
      additionalInstructions: "",
      customized: false,
      revision: 1,
    });
    expect(reset.resourceTools.map((binding) => binding.tool?.name)).toEqual([
      "call_store_revision_agent",
      "call_skill_revision_agent",
    ]);
  });

  it("customizes and resets Store Revision without removing its required tools", async () => {
    const registry = createDesktopSystemExpertRegistry();
    const original = registry.get(STORE_REVISION_EXPERT_REF)!;
    const customized = await registry.update(STORE_REVISION_EXPERT_REF, {
      name: "Knowledge Editor",
      description: "Customized sparse-draft editor.",
      tags: ["builtin", "revision"],
      additionalInstructions: "Prefer short topic files.",
      capabilities: [],
      toolApprovals: {},
      plugins: [],
      contextStoreMounts: [],
      resourceTools: [],
    });
    expect(customized).toMatchObject({ name: "Knowledge Editor", customized: true });
    expect(customized.opaqueCapabilities).toEqual(original.opaqueCapabilities);
    expect(registry.getResource(STORE_REVISION_EXPERT_REF)?.spec.capabilities).toEqual(
      expect.arrayContaining([expect.objectContaining({ ref: "capability:0000000000manage" })]),
    );
    await expect(registry.reset(STORE_REVISION_EXPERT_REF)).resolves.toMatchObject({
      name: "Store Revision Agent",
      customized: false,
    });
  });

  it("migrates a v3 customization from the versioned built-in Expert ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-system-experts-v3-"));
    directories.push(directory);
    const configPath = join(directory, "system-experts.json");
    // Captured from the v3 writer at 0bb33b457cab25484a373a6a394ca3c3d4ab4d68.
    const fixture = await readFile(
      new URL("./__fixtures__/system-experts-v3.json", import.meta.url),
      "utf8",
    );
    await writeFile(configPath, fixture);

    const reloaded = createDesktopSystemExpertRegistry({ configPath });
    await reloaded.initialize();

    expect(reloaded.get(BUILT_IN_PRAGMA_REF)).toMatchObject({
      name: "My Pragma",
      additionalInstructions: "Prefer concise plans and confirm destructive operations.",
      customized: true,
      executionProfile: { mode: "pinned", model: { runtimeId: "codex", modelId: "gpt-5.6" } },
      capabilities: [
        expect.objectContaining({ capabilityId: "11111111-1111-4111-8111-111111111111" }),
      ],
      contextStoreMounts: [
        expect.objectContaining({ storeId: "22222222-2222-4222-8222-222222222222" }),
      ],
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      schemaVersion: 8,
      customizations: [{ ref: BUILT_IN_PRAGMA_REF }],
    });
    await expect(readFile(`${configPath}.v3.backup.json`, "utf8")).resolves.toContain(
      "expert:pragma@1.0.0",
    );
  });

  it("migrates a real v5 customization without losing model or knowledge mounts", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-system-experts-v5-"));
    directories.push(directory);
    const configPath = join(directory, "system-experts.json");
    await writeFile(
      configPath,
      `${JSON.stringify(
        {
          schemaVersion: 5,
          customizations: [
            {
              avatarId: "pragma.avatar.expert.default",
              name: "Pragma",
              description:
                "The app's built-in general-purpose Agent for everyday work and expert orchestration.",
              tags: ["builtin", "pragma", "default-agent"],
              model: {
                runtimeId: "pi",
                providerId: "ad0aa84a-2057-4074-b138-408099ecac0a",
                modelId: "deepseek-v4-flash",
              },
              capabilities: [],
              toolApprovals: {},
              plugins: [],
              contextStoreMounts: [
                {
                  storeId: "26980318-cc35-4a16-95ae-fd8806492c4a",
                  enabled: true,
                  priority: 0,
                },
              ],
              additionalInstructions: "",
              ref: BUILT_IN_PRAGMA_REF,
              revision: 7,
              updatedAt: "2026-08-14T15:17:13.045Z",
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    const registry = createDesktopSystemExpertRegistry({ configPath });
    await registry.initialize();

    expect(registry.get(BUILT_IN_PRAGMA_REF)).toMatchObject({
      revision: 7,
      executionProfile: {
        mode: "pinned",
        model: { runtimeId: "pi", modelId: "deepseek-v4-flash" },
      },
      contextStoreMounts: [
        { storeId: "26980318-cc35-4a16-95ae-fd8806492c4a", enabled: true, priority: 0 },
      ],
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ schemaVersion: 8 });
    await expect(readFile(`${configPath}.v5.backup.json`, "utf8")).resolves.toContain(
      "deepseek-v4-flash",
    );
  });

  it("migrates v6 Pragma customizations with the new default revision agents", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-system-experts-v6-"));
    directories.push(directory);
    const configPath = join(directory, "system-experts.json");
    const fixture = await readFile(
      new URL("./__fixtures__/system-experts-v6.json", import.meta.url),
      "utf8",
    );
    await writeFile(configPath, fixture);
    const interruptedJournalPath = `${configPath}.migration-v6-to-v7.json`;
    await writeFile(
      interruptedJournalPath,
      JSON.stringify({
        schemaVersion: "pragma.system-expert-customization-migration/v1",
        sourceVersion: 6,
        targetVersion: 7,
        backupPath: `${configPath}.v6.backup.json`,
      }),
    );

    const reloaded = createDesktopSystemExpertRegistry({ configPath });
    await reloaded.initialize();

    expect(reloaded.get(BUILT_IN_PRAGMA_REF)?.resourceTools).toEqual([
      expect.objectContaining({
        tool: expect.objectContaining({ name: "call_store_revision_agent" }),
      }),
      expect.objectContaining({
        tool: expect.objectContaining({ name: "call_skill_revision_agent" }),
      }),
    ]);
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({ schemaVersion: 8 });
    await expect(readFile(`${configPath}.v6.backup.json`, "utf8")).resolves.toContain(
      "Preserve this v6 customization.",
    );
    await expect(readFile(interruptedJournalPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not rewrite a current v7 customization during initialization", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-system-experts-v7-noop-"));
    directories.push(directory);
    const configPath = join(directory, "system-experts.json");
    const registry = createDesktopSystemExpertRegistry({ configPath });
    await registry.initialize();
    const current = registry.get(BUILT_IN_PRAGMA_REF)!;
    await registry.update(BUILT_IN_PRAGMA_REF, {
      name: current.name,
      description: current.description,
      tags: current.tags,
      additionalInstructions: "Keep the current document byte-for-byte stable.",
      capabilities: [],
      toolApprovals: {},
      plugins: [],
      contextStoreMounts: [],
      resourceTools: current.resourceTools,
    });
    const before = await readFile(configPath, "utf8");

    await createDesktopSystemExpertRegistry({ configPath }).initialize();

    await expect(readFile(configPath, "utf8")).resolves.toBe(before);
  });

  it("fails closed on future customization schemas", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-system-experts-future-"));
    directories.push(directory);
    const configPath = join(directory, "system-experts.json");
    await writeFile(configPath, JSON.stringify({ schemaVersion: 99, customizations: [] }));
    await expect(createDesktopSystemExpertRegistry({ configPath }).initialize()).rejects.toThrow();
  });
});
