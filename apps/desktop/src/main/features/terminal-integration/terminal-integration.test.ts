import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { createTerminalIntegration } from "./terminal-integration.ts";
import { BEGIN, shellPathBlock, updateShellConfig } from "./shell-registration.ts";

const execute = promisify(execFile);
describe("Desktop terminal integration", () => {
  it.skipIf(process.platform === "win32")(
    "preserves other CLI installations and shell files across install, refresh, removal and opt-out",
    async () => {
      const home = await mkdtemp(join(tmpdir(), "pragma cli 中文' "));
      try {
        const resources = join(home, "Pragma.app/Contents/Resources");
        const executable = join(home, "Pragma.app/Contents/MacOS/Pragma");
        const client = join(resources, "app.asar.unpacked/out/main/desktop-cli/pragma.js");
        await mkdir(dirname(client), { recursive: true });
        await mkdir(dirname(executable), { recursive: true });
        await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, {
          mode: 0o700,
        });
        await writeFile(
          client,
          "process.stdout.write(JSON.stringify({args:process.argv.slice(2),cwd:process.cwd(),electron:process.env.ELECTRON_RUN_AS_NODE}))",
        );
        await writeFile(
          join(dirname(client), "distribution.json"),
          JSON.stringify({ cliVersion: "1.2.3" }),
        );
        const zshDirectory = join(home, "zsh");
        await mkdir(zshDirectory);
        await writeFile(join(zshDirectory, ".zshrc"), "# user's settings\n", { mode: 0o640 });
        await chmod(join(zshDirectory, ".zshrc"), 0o640);
        await writeFile(join(home, ".profile"), "# existing login profile\n");
        const other = join(home, "other");
        await mkdir(other);
        await writeFile(join(other, "pragma"), "#!/bin/sh\nprintf other", { mode: 0o700 });
        const integration = createTerminalIntegration({
          platform: "darwin",
          isPackaged: true,
          home,
          resources,
          executable,
          desktopVersion: "2.0.0",
          environment: { ZDOTDIR: zshDirectory },
        });
        expect((await integration.initialize()).status).toBe("ready");
        const launcher = join(home, ".pragma/bin/pragma");
        const result = await execute(launcher, ["中文", "two words", "a'\"$`b"], { cwd: other });
        expect(JSON.parse(result.stdout)).toEqual({
          args: ["中文", "two words", "a'\"$`b"],
          cwd: await realpath(other),
          electron: "1",
        });
        expect((await stat(join(zshDirectory, ".zshrc"))).mode & 0o777).toBe(0o640);
        expect(await readFile(join(zshDirectory, ".zshrc.pragma-backup"), "utf8")).toBe(
          "# user's settings\n",
        );
        await integration.initialize();
        expect((await readFile(join(zshDirectory, ".zshrc"), "utf8")).split(BEGIN)).toHaveLength(2);
        const fish = await execute("/usr/bin/which", ["fish"]).then(
          (result) => result.stdout.trim(),
          () => undefined,
        );
        for (const shell of ["zsh", "bash", ...(fish === undefined ? [] : ["fish"])] as (
          "zsh" | "bash" | "fish"
        )[]) {
          const output = await execute(
            shell === "zsh" ? "/bin/zsh" : shell === "bash" ? "/bin/bash" : fish!,
            ["-c", `${shellPathBlock(dirname(launcher), shell)}\ncommand -v pragma`],
            { env: { ...process.env, PATH: `${other}:/usr/bin:/bin:${dirname(launcher)}` } },
          );
          expect(output.stdout.trim()).toBe(launcher);
        }
        expect((await integration.remove()).status).toBe("removed");
        expect(await readFile(join(zshDirectory, ".zshrc"), "utf8")).toBe("# user's settings\n");
        expect(await readFile(join(other, "pragma"), "utf8")).toContain("other");
        expect((await integration.initialize()).status).toBe("removed");
        await expect(access(launcher)).rejects.toThrow();
        expect((await integration.repair()).status).toBe("ready");
        await rm(executable);
        await expect(execute(launcher)).rejects.toMatchObject({
          code: 127,
          stderr: expect.stringContaining("removed or moved"),
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    },
  );

  it("does not register development or mounted disk-image apps", async () => {
    for (const [isPackaged, executable] of [
      [false, "/Applications/Pragma.app/Contents/MacOS/Pragma"],
      [true, "/Volumes/Pragma/Pragma.app/Contents/MacOS/Pragma"],
    ] as const) {
      const integration = createTerminalIntegration({
        platform: "darwin",
        isPackaged,
        executable,
        resources: "/missing",
        desktopVersion: "1",
      });
      expect((await integration.initialize()).status).toBe("unavailable");
    }
  });

  it("preserves symlinked shell configuration and refuses malformed blocks", async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma-shell-config-"));
    try {
      const target = join(home, "dotfiles");
      const link = join(home, ".zshrc");
      await writeFile(target, "export TEST=yes\n");
      await chmod(target, 0o664);
      const originalMode = (await stat(target)).mode & 0o777;
      await symlink(target, link);
      const previousUmask = process.platform === "win32" ? undefined : process.umask(0o077);
      try {
        await updateShellConfig(link, shellPathBlock("/Applications/test with spaces", "zsh"));
      } finally {
        if (previousUmask !== undefined) process.umask(previousUmask);
      }
      expect((await stat(target)).mode & 0o777).toBe(originalMode);
      expect(await readFile(target, "utf8")).toContain(BEGIN);
      await updateShellConfig(link, undefined);
      expect((await stat(target)).mode & 0o777).toBe(originalMode);
      expect(await readFile(target, "utf8")).toBe("export TEST=yes\n");
      await writeFile(target, BEGIN);
      await expect(updateShellConfig(link, undefined)).rejects.toThrow("CLI_SHELL_CONFIG_INVALID");
      expect(await readFile(target, "utf8")).toBe(BEGIN);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});
