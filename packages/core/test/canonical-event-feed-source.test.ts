import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("starts a source worker without workspace dist or third-party declaration imports", async () => {
  const root = await mkdtemp(join(tmpdir(), "pragma-feed-source-"));
  const require = createRequire(import.meta.url);
  try {
    const shared = join(root, "packages/shared");
    await mkdir(join(root, "node_modules/@pragma"), { recursive: true });
    await symlink(shared, join(root, "node_modules/@pragma/shared"), "dir");
    await mkdir(shared, { recursive: true });
    await cp(new URL("../src", import.meta.url), join(root, "core/src"), { recursive: true });
    await cp(new URL("../../shared/src", import.meta.url), join(shared, "src"), {
      recursive: true,
    });
    await cp(new URL("../../shared/package.json", import.meta.url), join(shared, "package.json"));
    for (const name of ["zod", "tsx"]) {
      await symlink(
        dirname(require.resolve(`${name}/package.json`)),
        join(root, "node_modules", name),
        "dir",
      );
    }
    const driver = join(root, "driver.mjs");
    await writeFile(
      driver,
      `
      import { createFileCanonicalEventFeed } from './core/src/events/canonical-event-feed.ts';
      // The parent has loaded source. The worker must supply its own source condition.
      process.execArgv.splice(0, process.execArgv.length, '--import', 'tsx');
      const feed = await createFileCanonicalEventFeed({ pragmaHome: ${JSON.stringify(join(root, "home"))} });
      try {
        await feed.append([]);
        const state = await feed.inspect();
        if (state.eventCount !== 0) throw new Error('Unexpected feed state');
        process.stdout.write('ready');
      } finally { await feed.close(); }
    `,
    );
    const result = await promisify(execFile)(
      process.execPath,
      ["--import", "tsx", "--conditions=pragma-source", driver],
      { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 15_000 },
    );
    expect(result.stdout).toBe("ready");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
