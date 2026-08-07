import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { assertAntigravityWorkspaceCustomizationsAreIsolated } from "../src/workspace-customizations.ts";

describe("Antigravity workspace customizations", () => {
  it("allows a workspace without Antigravity customization roots", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "pragma-agy-clean-workspace-"));
    try {
      await expect(
        assertAntigravityWorkspaceCustomizationsAreIsolated(workspace),
      ).resolves.toBeUndefined();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it.each([".agents", ".agent", "_agents", "_agent"])(
    "fails closed before agy can load %s",
    async (customizationRoot) => {
      const workspace = await mkdtemp(join(tmpdir(), "pragma-agy-customizations-"));
      try {
        await mkdir(join(workspace, customizationRoot));
        await expect(
          assertAntigravityWorkspaceCustomizationsAreIsolated(workspace),
        ).rejects.toThrow(customizationRoot);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
  );
});
