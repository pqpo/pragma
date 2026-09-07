import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  PRAGMA_MANAGEMENT_BINDING_REF,
  PRAGMA_MANAGEMENT_CAPABILITY_REVISION,
  createPragmaManagementTools,
} from "@pragma/built-in-agents";

import { createDesktopAdapterHost } from "./mission-adapter-host.ts";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map(async (root) => {
      await rm(root, { recursive: true, force: true });
    }),
  );
});

describe("Desktop Pragma adapter Host", () => {
  it("does not resolve the management binding when no management ports are installed", async () => {
    const host = createDesktopAdapterHost(
      {} as Parameters<typeof createDesktopAdapterHost>[0],
      "/unused",
    );

    await expect(host.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF)).resolves.toBeUndefined();
  });

  it("fingerprints the complete management tool contract including approvals", async () => {
    const pragmaManagement = { knowledgeRevisions: {} as never };
    const host = createDesktopAdapterHost(
      { pragmaManagement } as unknown as Parameters<typeof createDesktopAdapterHost>[0],
      "/unused",
    );
    const tools = createPragmaManagementTools(pragmaManagement);
    const expectedFingerprint = createHash("sha256")
      .update(
        JSON.stringify(
          tools.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
            approval: tool.approval,
          })),
        ),
      )
      .digest("hex");

    await expect(host.resolveBinding(PRAGMA_MANAGEMENT_BINDING_REF)).resolves.toMatchObject({
      revision: String(PRAGMA_MANAGEMENT_CAPABILITY_REVISION),
      fingerprint: expectedFingerprint,
    });
  });

  it("opens a real file Context store at the composition boundary", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "pragma-desktop-file-context-"));
    temporaryRoots.push(rootDir);
    await writeFile(join(rootDir, "rules.md"), "# Rules\nKeep boundaries explicit.\n", "utf8");
    const host = createDesktopAdapterHost(
      {} as Parameters<typeof createDesktopAdapterHost>[0],
      rootDir,
    );

    const store = host.openFileContextStore?.({ rootDir });
    await expect(store?.readContext({ id: "rules.md" })).resolves.toMatchObject({
      ok: true,
      value: { content: "# Rules\nKeep boundaries explicit.\n" },
    });
  });
});
