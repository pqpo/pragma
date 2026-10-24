import {
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createPiSessionBashTool } from "../src/adapter.ts";
import { withPiToolApproval } from "../src/permissions.ts";
import type { ExpertAgentHumanInteractionHandler } from "@pragma/core";

// Recreating the native tools mirrors a restored Session's preparation; the
// actual filesystem and shell are used so a denied call cannot fake success.
describe("Pi native permission modes", () => {
  it.each(["request-approval", "auto-approve", "full-access"] as const)(
    "gates native mutations on first execution and restore in %s",
    async (permissionMode) => {
      const cwd = await mkdtemp(join(tmpdir(), "pragma-pi-permissions-"));
      let approved = true;
      const handler = vi.fn<ExpertAgentHumanInteractionHandler>(async () => ({
        kind: "tool_approval",
        approved,
      }));
      try {
        for (const phase of ["fresh", "restored"] as const) {
          const options = { permissionMode, humanInteractionHandler: handler };
          const bash = createPiSessionBashTool({
            cwd,
            processEnvironment: { ...process.env },
            ...options,
          });
          const write = withPiToolApproval(createWriteToolDefinition(cwd), options);
          const edit = withPiToolApproval(createEditToolDefinition(cwd), options);
          const invoke = async (tool: typeof bash, args: unknown) =>
            await tool.execute(phase, args, undefined, undefined, undefined as never);
          await invoke(bash, { command: `printf ${phase} > ${phase}.txt` });
          expect(await readFile(join(cwd, `${phase}.txt`), "utf8")).toBe(phase);
          await write.execute(
            "write",
            { path: "document.txt", content: phase },
            undefined,
            undefined,
            undefined as never,
          );
          await edit.execute(
            "edit",
            { path: "document.txt", edits: [{ oldText: phase, newText: `${phase}-edited` }] },
            undefined,
            undefined,
            undefined as never,
          );
          expect(await readFile(join(cwd, "document.txt"), "utf8")).toBe(`${phase}-edited`);
          if (permissionMode === "request-approval") {
            approved = false;
            await expect(invoke(bash, { command: "printf denied > denied.txt" })).rejects.toThrow(
              "declined",
            );
            await expect(readFile(join(cwd, "denied.txt"))).rejects.toMatchObject({
              code: "ENOENT",
            });
            await expect(
              write.execute(
                "denied-write",
                { path: "document.txt", content: "denied" },
                undefined,
                undefined,
                undefined as never,
              ),
            ).rejects.toThrow("declined");
            await expect(
              edit.execute(
                "denied-edit",
                {
                  path: "document.txt",
                  edits: [{ oldText: `${phase}-edited`, newText: "denied" }],
                },
                undefined,
                undefined,
                undefined as never,
              ),
            ).rejects.toThrow("declined");
            expect(await readFile(join(cwd, "document.txt"), "utf8")).toBe(`${phase}-edited`);
            approved = true;
            await invoke(bash, { command: `printf retry > retry.txt` });
            expect(await readFile(join(cwd, "retry.txt"), "utf8")).toBe("retry");
          }
        }
        expect(handler).toHaveBeenCalledTimes(permissionMode === "request-approval" ? 14 : 0);
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  it("fails closed without a Host, validates approved edits and cancels before spawning", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pragma-pi-denial-"));
    const invoke = async (tool: ReturnType<typeof createPiSessionBashTool>, signal?: AbortSignal) =>
      await tool.execute(
        "probe",
        { command: "printf original > original.txt" },
        signal,
        undefined,
        undefined as never,
      );
    try {
      await expect(
        invoke(createPiSessionBashTool({ cwd, processEnvironment: process.env })),
      ).rejects.toThrow("no approval handler");
      const edited = createPiSessionBashTool({
        cwd,
        processEnvironment: process.env,
        humanInteractionHandler: async () => ({
          kind: "tool_approval",
          approved: true,
          updatedInput: { command: "printf edited > edited.txt" },
        }),
      });
      await invoke(edited);
      expect(await readFile(join(cwd, "edited.txt"), "utf8")).toBe("edited");
      await expect(readFile(join(cwd, "original.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      const invalid = createPiSessionBashTool({
        cwd,
        processEnvironment: process.env,
        humanInteractionHandler: async () => ({
          kind: "tool_approval",
          approved: true,
          updatedInput: {},
        }),
      });
      await expect(invoke(invalid)).rejects.toThrow();
      await expect(invoke(edited, AbortSignal.abort())).rejects.toThrow();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
