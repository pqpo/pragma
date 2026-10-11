import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pnpmInvocation } from "./pnpm-command.mjs";

test("Windows pnpm invocation preserves spaces and shell characters in arguments", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma pnpm "));
  try {
    const pnpmEntry = join(root, "pnpm entry.mjs");
    await writeFile(pnpmEntry, "process.stdout.write(JSON.stringify(process.argv.slice(2)))");
    const args = ["exec", "vitest", "run", "-t", "loads the durable tracking cutoff", "a&b"];
    const invocation = pnpmInvocation(args, { platform: "win32", pnpmEntry });
    const received = JSON.parse(
      execFileSync(invocation.command, invocation.args, { encoding: "utf8", shell: false }),
    );
    assert.deepEqual(received, args);
    assert.deepEqual(pnpmInvocation(args, { platform: "darwin" }), { command: "pnpm", args });
    for (const entry of ["", "pnpm.cmd", "pnpm.exe"])
      assert.throws(
        () => pnpmInvocation(args, { platform: "win32", pnpmEntry: entry }),
        /through pnpm/,
      );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
