import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { executeManagementMutation } from "../src/management-mutation.ts";

describe("recoverable management mutation", () => {
  it("keeps planned identities and cleanup progress across failure, replays once and rejects future state", async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-management-mutation-"));
    try {
      let fail = true;
      const cleanup = vi.fn();
      const prepare = vi.fn(async () => ({ generation: crypto.randomUUID() }));
      const applied: string[] = [];
      const options = {
        root,
        operationId: "one-operation",
        target: "automation:000000000000a111",
        input: { action: "reset" },
        stateSchema: z.object({ generation: z.string().uuid() }).strict(),
        resultSchema: z.object({ generation: z.string().uuid() }).strict(),
        prepare,
        apply: async (
          state: { generation: string },
          _publicationId: string,
          progress: { completed(step: string): boolean; complete(step: string): Promise<void> },
        ) => {
          applied.push(state.generation);
          if (!progress.completed("cleaned")) {
            cleanup();
            await progress.complete("cleaned");
          }
          if (fail) throw new Error("result not persisted");
          return state;
        },
      };
      await expect(executeManagementMutation(options)).rejects.toThrow("result not persisted");
      fail = false;
      const recovered = await executeManagementMutation(options);
      expect(await executeManagementMutation(options)).toEqual(recovered);
      expect(applied).toEqual([recovered.generation, recovered.generation]);
      expect(prepare).toHaveBeenCalledOnce();
      expect(cleanup).toHaveBeenCalledOnce();
      await expect(
        executeManagementMutation({ ...options, input: { action: "delete" } }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
      const path = join(
        root,
        "operations",
        `${createHash("sha256").update(options.operationId).digest("hex")}.json`,
      );
      const original = JSON.parse(await readFile(path, "utf8"));
      const future = JSON.stringify({
        ...original,
        schemaVersion: "pragma.management-mutation/v2",
      });
      await writeFile(path, future);
      await expect(executeManagementMutation(options)).rejects.toMatchObject({
        code: "STORAGE_VERSION_UNSUPPORTED",
      });
      expect(await readFile(path, "utf8")).toBe(future);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
