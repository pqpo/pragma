import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BUILT_IN_AGENT_REFS, BUILT_IN_PRAGMA_REF } from "@pragma/built-in-agents";

import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";

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
  });

  it("reserves the four managed Agent identities without exposing customization surfaces", async () => {
    const registry = createDesktopSystemExpertRegistry();
    const managedRefs = BUILT_IN_AGENT_REFS.filter((ref) => ref !== BUILT_IN_PRAGMA_REF);

    expect(managedRefs).toHaveLength(4);
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
        }),
      ).rejects.toThrow("Built-in Expert not found");
    }
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
      capabilities: [{ kind: "tools", capabilityId, revision: 3, toolNames: ["search_docs"] }],
      toolApprovals: { mcp_docs_search_docs: "required" },
      plugins: [],
      contextStoreMounts: [{ storeId: contextStoreId, enabled: true, priority: 0 }],
    });

    expect(customized).toMatchObject({
      name: "My Pragma",
      customized: true,
      revision: 2,
      scope: original.scope,
      instructions: original.instructions,
      additionalInstructions: "Prefer concise plans and confirm destructive operations.",
      executionProfile: { mode: "pinned", model: { runtimeId: "codex", modelId: "gpt-5.6" } },
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

    await expect(registry.upgradeCapabilityRevision(capabilityId, 4)).resolves.toBe(true);
    expect(registry.get(BUILT_IN_PRAGMA_REF)).toMatchObject({
      revision: 3,
      capabilities: [{ capabilityId, revision: 4 }],
    });
    expect(
      registry
        .getAdditionalResources(BUILT_IN_PRAGMA_REF)
        .find((resource) => resource.kind === "Capability"),
    ).toMatchObject({ spec: { binding: expect.stringMatching(/\.4$/) } });

    const reloaded = createDesktopSystemExpertRegistry({ configPath });
    await reloaded.initialize();
    expect(reloaded.get(BUILT_IN_PRAGMA_REF)).toMatchObject({
      name: "My Pragma",
      customized: true,
      additionalInstructions: "Prefer concise plans and confirm destructive operations.",
    });

    const reset = await reloaded.reset(BUILT_IN_PRAGMA_REF);
    expect(reset).toMatchObject({
      name: original.name,
      instructions: original.instructions,
      additionalInstructions: "",
      customized: false,
      revision: 1,
    });
  });

  it("migrates a v3 customization from the versioned built-in Expert ref", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-system-experts-v3-"));
    directories.push(directory);
    const configPath = join(directory, "system-experts.json");
    const registry = createDesktopSystemExpertRegistry({ configPath });
    await registry.initialize();
    await registry.update(BUILT_IN_PRAGMA_REF, {
      name: "Legacy Pragma",
      description: "A legacy customized built-in Pragma Agent.",
      tags: ["builtin", "legacy"],
      additionalInstructions: "Preserve this customization.",
      capabilities: [],
      toolApprovals: {},
      plugins: [],
      contextStoreMounts: [],
    });
    const legacy = JSON.parse(await readFile(configPath, "utf8")) as {
      schemaVersion: number;
      customizations: { ref: string }[];
    };
    legacy.schemaVersion = 3;
    legacy.customizations[0]!.ref = "expert:pragma@1.0.0";
    await writeFile(configPath, `${JSON.stringify(legacy, null, 2)}\n`);

    const reloaded = createDesktopSystemExpertRegistry({ configPath });
    await reloaded.initialize();

    expect(reloaded.get(BUILT_IN_PRAGMA_REF)).toMatchObject({
      name: "Legacy Pragma",
      additionalInstructions: "Preserve this customization.",
      customized: true,
    });
    expect(JSON.parse(await readFile(configPath, "utf8"))).toMatchObject({
      schemaVersion: 4,
      customizations: [{ ref: BUILT_IN_PRAGMA_REF }],
    });
  });
});
