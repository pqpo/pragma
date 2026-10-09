import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

it.skipIf(process.platform === "win32")(
  "keeps the process-local launcher executable during concurrent preparation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "pragma-command-launcher-"));
    try {
      const module = join(root, "host.mjs");
      await build({
        entryPoints: [fileURLToPath(new URL("./pragma-command-distribution.ts", import.meta.url))],
        outfile: module,
        bundle: true,
        platform: "node",
        target: "node22",
        format: "esm",
      });
      await writeFile(
        join(root, "pragma-command-client.js"),
        "process.stdout.write(JSON.stringify({args:process.argv.slice(2),runAsNode:process.env.ELECTRON_RUN_AS_NODE}))",
      );
      const { prepareDesktopPragmaCommand } = (await import(
        pathToFileURL(module).href
      )) as typeof import("./pragma-command-distribution.ts");
      const directory = await prepareDesktopPragmaCommand({ cacheRoot: join(root, "cache") });
      const launcher = join(directory, "pragma");
      const execute = promisify(execFile);
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          await prepareDesktopPragmaCommand({ cacheRoot: join(root, "cache") });
          const result = await execute(launcher, ["flow", "中文", "two words"]);
          expect(JSON.parse(result.stdout)).toEqual({
            args: ["flow", "中文", "two words"],
            runAsNode: "1",
          });
        }),
      );
      expect((await stat(launcher)).mode & 0o777).toBe(0o700);
      expect(await readdir(directory)).toEqual(["pragma"]);
      expect(await readFile(launcher, "utf8")).not.toContain("PRAGMA_EXECUTION_COMMAND_ENDPOINT=");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
