import { describe, expect, it, vi } from "vitest";
import {
  PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
  PRAGMA_MANAGEMENT_TOOL_DEFINITIONS,
} from "@pragma/built-in-agents";

import {
  BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY,
  listCapabilitiesWithBuiltIns,
  testBuiltInCapability,
} from "./built-in-capabilities.ts";

describe("built-in capabilities", () => {
  it("places the Pragma management capability in the capability catalog", async () => {
    expect(BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.manifest.latestRevision).toBe(
      PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
    );
    expect(BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.health.revision).toBe(
      PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
    );
    const userCapability = {
      ...BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY,
      managedBy: "user" as const,
      manifest: {
        ...BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.manifest,
        id: "00000000-0000-4000-8000-000000000000",
      },
    };

    await expect(
      listCapabilitiesWithBuiltIns({ list: async () => [userCapability] }),
    ).resolves.toEqual([BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY, userCapability]);
  });

  it("publishes the authoritative input schema for every management tool", () => {
    const capability = BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.definition;
    expect(capability.kind).toBe("mcp_server");
    if (capability.kind !== "mcp_server") return;

    expect(PRAGMA_MANAGEMENT_TOOL_DEFINITIONS).toHaveLength(36);
    expect(new Set(PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.map(({ name }) => name)).size).toBe(36);
    expect(PRAGMA_MANAGEMENT_TOOL_DEFINITIONS.map(({ name }) => name)).toEqual(
      expect.arrayContaining([
        "list_dsl_resources",
        "submit_task",
        "save_automation",
        "knowledge_revision_start",
      ]),
    );

    for (const expected of PRAGMA_MANAGEMENT_TOOL_DEFINITIONS) {
      expect(capability.tools.find((tool) => tool.name === expected.name)).toMatchObject({
        name: expected.name,
        description: expected.description,
        inputSchema: expected.inputSchema,
      });
    }
  });

  it("tests the read-only listing tool against the Host port", async () => {
    const listTargets = vi.fn(async () => []);
    const result = await testBuiltInCapability(
      {
        id: BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.manifest.id,
        toolName: "knowledge_revision_list_targets",
        input: {},
      },
      { knowledgeRevisions: revisionPort({ listTargets }) },
      vi.fn(),
    );

    expect(result).toMatchObject({ ok: true, code: "success", output: [] });
    expect(listTargets).toHaveBeenCalledOnce();
  });

  it("tests a resource management tool through the same unified factory", async () => {
    const list = vi.fn(async () => ({ projectRevision: 7, resources: [] }));
    const result = await testBuiltInCapability(
      {
        id: BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.manifest.id,
        toolName: "list_dsl_resources",
        input: {},
      },
      {
        project: { list } as never,
        tasks: {} as never,
      },
      vi.fn(),
    );

    expect(result).toMatchObject({
      ok: true,
      code: "success",
      output: { projectRevision: 7, resources: [] },
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it("requires approval before a test creates a revision request", async () => {
    const start = vi.fn();
    const result = await testBuiltInCapability(
      {
        id: BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.manifest.id,
        toolName: "knowledge_revision_start",
        input: { targetRef: "context:test", prompt: "Revise this knowledge." },
      },
      { knowledgeRevisions: revisionPort({ start }) },
      async () => false,
    );

    expect(result).toMatchObject({ ok: false, code: "approval_denied" });
    expect(start).not.toHaveBeenCalled();
  });
});

function revisionPort(overrides: Record<string, unknown> = {}) {
  return {
    listTargets: vi.fn(async () => []),
    listDrafts: vi.fn(async () => []),
    start: vi.fn(async () => ({})),
    getDraft: vi.fn(),
    inspectRebase: vi.fn(),
    rebase: vi.fn(),
    submitDraft: vi.fn(),
    discardDraft: vi.fn(),
    ...overrides,
  };
}
