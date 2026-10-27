import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it, vi } from "vitest";
import { DEFAULT_DISTRIBUTION, type DistributionConfig } from "@pragma/shared/distribution";
import { createTerminalIntegration } from "./terminal-integration.ts";

const execute = promisify(execFile);
const derived: DistributionConfig = {
  ...DEFAULT_DISTRIBUTION,
  id: "acme",
  productName: "Acme",
  applicationId: "com.acme.pragma",
  applicationName: "Acme Desktop",
  executableName: "Acme",
  homeDirectory: ".acme",
  developmentHomeDirectory: ".acme-development",
  userDataDirectory: "Acme Desktop",
  userDataDevelopmentDirectory: "Acme Development",
  homeEnvironmentVariable: "ACME_HOME",
  credentialNamespace: "acme",
  cliPackageName: "@acme/pragma",
  cliCommand: "acme",
  desktopCliCommand: "acme-desktop",
};
afterEach(() => vi.unstubAllGlobals());
it.skipIf(process.platform === "win32")(
  "two distributions preserve each other's launchers, shell entries and opt-out across repair/removal",
  async () => {
    const home = await mkdtemp(join(tmpdir(), "pragma coexist 中文' "));
    try {
      await writeFile(join(home, ".zshrc"), "# user configuration\n");
      const create = async (profile: DistributionConfig) => {
        vi.stubGlobal("__PRAGMA_DISTRIBUTION__", profile);
        const resources = join(home, `${profile.executableName}.app/Contents/Resources`);
        const executable = join(
          home,
          `${profile.executableName}.app/Contents/MacOS`,
          profile.executableName,
        );
        const client = join(resources, "app.asar.unpacked/out/main/desktop-cli/pragma.js");
        await mkdir(dirname(client), { recursive: true });
        await mkdir(dirname(executable), { recursive: true });
        await writeFile(executable, `#!/bin/sh\nexec '${process.execPath}' "$@"\n`, {
          mode: 0o700,
        });
        await writeFile(client, `process.stdout.write(${JSON.stringify(profile.id)})`);
        await writeFile(
          join(dirname(client), "distribution.json"),
          JSON.stringify({ cliVersion: "1.0.0" }),
        );
        const integration = createTerminalIntegration({
          home,
          platform: "darwin",
          isPackaged: true,
          executable,
          resources,
          desktopVersion: "1.0.0",
          environment: { ZDOTDIR: home },
        });
        expect((await integration.initialize()).status).toBe("ready");
        return integration;
      };
      const open = await create(DEFAULT_DISTRIBUTION);
      const enterprise = await create(derived);
      const originalCommand = join(home, ".pragma/bin/pragma");
      const enterpriseCommand = join(home, ".acme/bin/acme");
      expect((await execute(originalCommand)).stdout).toBe("pragma");
      expect((await execute(enterpriseCommand)).stdout).toBe("acme");
      expect(await readFile(join(home, ".zshrc"), "utf8")).toContain(
        "# >>> Pragma Desktop CLI >>>",
      );
      expect((await enterprise.remove()).status).toBe("removed");
      expect((await enterprise.initialize()).status).toBe("removed");
      expect((await execute(originalCommand)).stdout).toBe("pragma");
      vi.stubGlobal("__PRAGMA_DISTRIBUTION__", DEFAULT_DISTRIBUTION);
      expect((await open.repair()).status).toBe("ready");
      vi.stubGlobal("__PRAGMA_DISTRIBUTION__", derived);
      expect((await enterprise.repair()).status).toBe("ready");
      vi.stubGlobal("__PRAGMA_DISTRIBUTION__", DEFAULT_DISTRIBUTION);
      expect((await open.remove()).status).toBe("removed");
      expect((await execute(enterpriseCommand)).stdout).toBe("acme");
      const shell = await readFile(join(home, ".zshrc"), "utf8");
      expect(shell).toContain("# user configuration");
      expect(shell).toContain("# >>> acme Desktop CLI >>>");
      expect(shell).not.toContain("# >>> Pragma Desktop CLI >>>");
      vi.stubGlobal("__PRAGMA_DISTRIBUTION__", derived);
      await enterprise.remove();
      await writeFile(enterpriseCommand, "# owned by user\n");
      expect((await enterprise.repair()).error).toContain("CLI_ENTRY_CONFLICT");
      await enterprise.remove();
      expect(await readFile(enterpriseCommand, "utf8")).toBe("# owned by user\n");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);
