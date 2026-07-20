import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BUILT_IN_STEWARD_REF } from "@pragma/steward";

import { createDesktopSystemExpertRegistry } from "./system-expert-registry.ts";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("DesktopSystemExpertRegistry", () => {
  it("exposes the Steward as a read-only, system-default Expert and mission executor", () => {
    const registry = createDesktopSystemExpertRegistry();
    const definition = registry.get(BUILT_IN_STEWARD_REF);

    expect(definition).toMatchObject({
      ref: BUILT_IN_STEWARD_REF,
      id: "steward",
      origin: "built-in",
      readOnly: true,
      customized: false,
      executionProfile: { mode: "system-default" },
    });
    expect(registry.list()).toContainEqual(
      expect.objectContaining({ ref: BUILT_IN_STEWARD_REF, readOnly: true }),
    );
    expect(registry.listExecutors()).toContainEqual(
      expect.objectContaining({
        ref: BUILT_IN_STEWARD_REF,
        kind: "expert",
        origin: "built-in",
        readOnly: true,
      }),
    );
    expect(registry.isReservedRef(BUILT_IN_STEWARD_REF)).toBe(true);
    expect(registry.isReservedId("steward")).toBe(true);
    expect(registry.fingerprint(BUILT_IN_STEWARD_REF)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("persists an editable override and resets to the shipped definition", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pragma-system-experts-"));
    directories.push(directory);
    const configPath = join(directory, "system-experts.json");
    const registry = createDesktopSystemExpertRegistry({ configPath });
    await registry.initialize();
    const original = registry.get(BUILT_IN_STEWARD_REF)!;
    const originalFingerprint = registry.fingerprint(BUILT_IN_STEWARD_REF);
    const capabilityId = "11111111-1111-4111-8111-111111111111";
    const contextStoreId = "22222222-2222-4222-8222-222222222222";

    const customized = await registry.update(BUILT_IN_STEWARD_REF, {
      name: "My Steward",
      description: "A customized built-in Steward.",
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
      name: "My Steward",
      customized: true,
      revision: 2,
      scope: original.scope,
      instructions: original.instructions,
      additionalInstructions: "Prefer concise plans and confirm destructive operations.",
      executionProfile: { mode: "pinned", model: { runtimeId: "codex", modelId: "gpt-5.6" } },
    });
    expect(registry.getResource(BUILT_IN_STEWARD_REF)?.spec.instructions).toContain(
      original.instructions,
    );
    expect(registry.getResource(BUILT_IN_STEWARD_REF)?.spec.instructions).toContain(
      "User customization:\nPrefer concise plans",
    );
    expect(registry.getResource(BUILT_IN_STEWARD_REF)?.spec.capabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ref: expect.stringContaining(capabilityId.replaceAll("-", "")),
          tools: ["search_docs"],
        }),
      ]),
    );
    expect(registry.getAdditionalResources(BUILT_IN_STEWARD_REF)).toHaveLength(2);
    expect(registry.fingerprint(BUILT_IN_STEWARD_REF)).not.toBe(originalFingerprint);

    const reloaded = createDesktopSystemExpertRegistry({ configPath });
    await reloaded.initialize();
    expect(reloaded.get(BUILT_IN_STEWARD_REF)).toMatchObject({
      name: "My Steward",
      customized: true,
      additionalInstructions: "Prefer concise plans and confirm destructive operations.",
    });

    const reset = await reloaded.reset(BUILT_IN_STEWARD_REF);
    expect(reset).toMatchObject({
      name: original.name,
      instructions: original.instructions,
      additionalInstructions: "",
      customized: false,
      revision: 1,
    });
  });
});
