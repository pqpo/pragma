import { describe, expect, it, vi } from "vitest";

import {
  BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY,
  listCapabilitiesWithBuiltIns,
  testBuiltInCapability,
} from "./built-in-capabilities.ts";

describe("built-in capabilities", () => {
  it("places the Pragma management capability in the capability catalog", async () => {
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

  it("tests the read-only listing tool against the Host port", async () => {
    const listTargets = vi.fn(async () => []);
    const result = await testBuiltInCapability(
      {
        id: BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.manifest.id,
        toolName: "list_knowledge_revision_targets",
        input: {},
      },
      { listTargets, submit: vi.fn() },
      vi.fn(),
    );

    expect(result).toMatchObject({ ok: true, code: "success", output: [] });
    expect(listTargets).toHaveBeenCalledOnce();
  });

  it("requires approval before a test creates a revision request", async () => {
    const submit = vi.fn();
    const result = await testBuiltInCapability(
      {
        id: BUILT_IN_PRAGMA_MANAGEMENT_CAPABILITY.manifest.id,
        toolName: "submit_knowledge_revision",
        input: { targetRef: "context:test", prompt: "Revise this knowledge." },
      },
      { listTargets: vi.fn(), submit },
      async () => false,
    );

    expect(result).toMatchObject({ ok: false, code: "approval_denied" });
    expect(submit).not.toHaveBeenCalled();
  });
});
