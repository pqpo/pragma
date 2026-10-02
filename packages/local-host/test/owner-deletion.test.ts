import { execFileSync } from "node:child_process";
import { mkdtemp, rm, mkdir, writeFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, it, expect } from "vitest";
import { PragmaPaths, fenceOwnerDeletion, isOwnerDeletionFenced, withFileLock } from "@pragma/core";

import { createSqliteExecutionStore } from "../src/index.ts";

describe("Owner deletion fence", () => {
  it("takes Session locks before delivery locks used by an admitted Session writer", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-deletion-order-"));
    const paths = new PragmaPaths({ pragmaHome: home });
    let admitted!: () => void;
    let proceed!: () => void;
    const ready = new Promise<void>((resolve) => {
      admitted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      proceed = resolve;
    });
    const writer = withFileLock(paths.expertSessionLock("session"), async () => {
      admitted();
      await gate;
      await withFileLock(paths.canonicalEventDeliveryLock("execution"), async () => {});
    });
    await ready;
    const store = createSqliteExecutionStore({ pragmaHome: home });
    const deletion = store.withCanonicalEventDeletion(["execution"], async () => {}, ["session"]);
    await new Promise((resolve) => setTimeout(resolve, 50));
    proceed();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        Promise.all([writer, deletion]),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => reject(new Error("Session/delivery lock inversion")), 1_000);
        }),
      ]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      await store.close();
      await rm(home, { recursive: true, force: true });
    }
  });
  it("survives owner moves and is visible to another store instance", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-fence-"));
    try {
      const paths = new PragmaPaths({ pragmaHome: home });
      await mkdir(paths.executionRoot("execution"), { recursive: true });
      await fenceOwnerDeletion(paths, ["execution", "execution"]);
      await rename(paths.executionRoot("execution"), join(home, "removed"));
      expect(isOwnerDeletionFenced(new PragmaPaths({ pragmaHome: home }), "execution")).toBe(true);
      expect(isOwnerDeletionFenced(paths, "unrelated")).toBe(false);
      const source = new URL("../src/index.ts", import.meta.url).href;
      const result = execFileSync(
        process.execPath,
        [
          "--import",
          "tsx",
          "-e",
          `
        import { createSqliteExecutionStore } from ${JSON.stringify(source)};
        import { PragmaPaths, isOwnerDeletionFenced } from "@pragma/core";
        const paths = new PragmaPaths({ pragmaHome: process.argv[1] });
        if (!isOwnerDeletionFenced(paths, "execution")) throw new Error("Fence missing across processes");
        const store = createSqliteExecutionStore({ pragmaHome: paths.root });
        try { await store.commit({ executionId: "execution", commitId: "late", events: [] }); throw new Error("Late write accepted"); }
        catch (error) { if (!error.message.includes("deletion is fenced")) throw error; }
        finally { await store.close(); }
        process.stdout.write("fenced");
      `,
          home,
        ],
        { encoding: "utf8" },
      );
      expect(result).toBe("fenced");
      await writeFile(
        paths.ownerDeletionMarker("execution"),
        JSON.stringify({ schemaVersion: "pragma.owner-deletion/v2", ownerId: "execution" }),
      );
      expect(() => isOwnerDeletionFenced(paths, "execution")).toThrow();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
