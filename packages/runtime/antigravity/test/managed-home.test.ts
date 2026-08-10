import { chmod, lstat, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { Expert } from "@pragma/core";
import { afterEach, describe, expect, it } from "vitest";

import {
  createHostKeyringAntigravityEnvironment,
  createManagedAntigravityIdentity,
  createManagedAntigravityEnvironment,
  managedAgentName,
  prepareManagedAntigravityHome,
  resolveAntigravityAuthenticationMode,
  resolveAntigravityHostHome,
} from "../src/managed-home.ts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(async (directory) => {
      await rm(directory, { recursive: true, force: true });
    }),
  );
});

describe("managed Antigravity HOME", () => {
  it("uses a Session customization workspace while preserving host HOME for keyring OAuth", async () => {
    const root = await temporaryRoot();
    const hostHome = join(root, "host-home");
    const sessionDir = join(root, "session");
    await mkdir(hostHome, { recursive: true });
    const managed = await prepareManagedAntigravityHome({
      agent: createExpert(root),
      sessionDir,
      systemPrompt: "host-keyring system",
      mcpServerUrl: "http://127.0.0.1/host-keyring/mcp",
      hookRelay: relay(),
      permissionMode: "request-approval",
      authenticationMode: "host-keyring",
      processEnvironment: {
        HOME: hostHome,
        XDG_CONFIG_HOME: join(hostHome, ".config"),
        ANTIGRAVITY_CONVERSATION_ID: "stale-host-session",
        PRAGMA_AGY_HOOK_AUTHORIZATION: "stale-secret",
      },
      platform: "linux",
    });

    expect(managed).toMatchObject({
      authenticationMode: "host-keyring",
      homeDir: hostHome,
      configDir: join(sessionDir, "managed-customizations", ".agents"),
      customizationWorkspace: join(sessionDir, "managed-customizations"),
    });
    expect(managed.env).toMatchObject({
      HOME: hostHome,
      XDG_CONFIG_HOME: join(hostHome, ".config"),
      TMPDIR: join(sessionDir, "tmp"),
    });
    expect(managed.env["ANTIGRAVITY_CONVERSATION_ID"]).toBeUndefined();
    expect(managed.env["PRAGMA_AGY_HOOK_AUTHORIZATION"]).toBeUndefined();
    await expect(
      stat(join(hostHome, ".gemini", "antigravity-cli", "settings.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readJson(join(managed.configDir, "mcp_config.json"))).resolves.toEqual({
      mcpServers: {
        [managed.mcpServerName]: { serverUrl: "http://127.0.0.1/host-keyring/mcp" },
      },
    });
    await expect(
      readFile(join(managed.configDir, "agents", managed.agentName, "agent.md"), "utf8"),
    ).resolves.toContain("host-keyring system");
    await expect(readJson(join(managed.configDir, "hooks.json"))).resolves.toHaveProperty(
      managed.hookName,
    );
  });

  it("auto-selects private HOME only when the official ADC switch is enabled", () => {
    expect(resolveAntigravityAuthenticationMode("auto", { HOME: "/host" }, "linux")).toBe(
      "host-keyring",
    );
    expect(
      resolveAntigravityAuthenticationMode(
        "auto",
        { HOME: "/host", AGY_ADC_AUTH: "true" },
        "linux",
      ),
    ).toBe("isolated-environment");
    expect(
      resolveAntigravityAuthenticationMode(
        "auto",
        { HOME: "/host", AGY_ADC_AUTH: "false" },
        "linux",
      ),
    ).toBe("host-keyring");
  });

  it("resolves Windows host HOME case-insensitively and rejects missing host identity", () => {
    expect(resolveAntigravityHostHome({ UserProfile: "C:\\Users\\Pragma" }, "win32")).toBe(
      "C:\\Users\\Pragma",
    );
    expect(
      resolveAntigravityHostHome({ HomeDrive: "C:", HomePath: "\\Users\\Pragma" }, "win32"),
    ).toBe("C:\\Users\\Pragma");
    expect(() => resolveAntigravityHostHome({}, "linux")).toThrow(/host HOME\/USERPROFILE/i);
    expect(() =>
      resolveAntigravityHostHome({ HomeDrive: "C:", HomePath: "Users\\Pragma" }, "win32"),
    ).toThrow(/absolute host HOME\/USERPROFILE/i);
    const env = createHostKeyringAntigravityEnvironment({
      base: {
        Home: "C:\\Users\\Pragma",
        UserProfile: "C:\\Users\\Pragma",
        Agy_Adc_Auth: "true",
        Antigravity_Conversation_Id: "stale",
        API_KEY: "preserved",
      },
      tmpDir: "C:\\Pragma\\tmp",
      platform: "win32",
    });
    expect(env).toMatchObject({
      Home: "C:\\Users\\Pragma",
      UserProfile: "C:\\Users\\Pragma",
      API_KEY: "preserved",
      TMP: "C:\\Pragma\\tmp",
    });
    expect(
      Object.keys(env).some((key) => key.toLowerCase() === "antigravity_conversation_id"),
    ).toBe(false);
    expect(Object.keys(env).some((key) => key.toLowerCase() === "agy_adc_auth")).toBe(false);
  });

  it("materializes the exact system prompt, MCP bridge, approval hook, and complete skills", async () => {
    const root = await temporaryRoot();
    const skillRoot = join(root, "source-skill");
    await Promise.all([
      mkdir(join(skillRoot, "references"), { recursive: true }),
      mkdir(join(skillRoot, "scripts"), { recursive: true }),
      mkdir(join(skillRoot, "node_modules", "ignored"), { recursive: true }),
    ]);
    await Promise.all([
      writeFile(join(skillRoot, "SKILL.md"), "# Review\n\nUse the reference.\n"),
      writeFile(join(skillRoot, "references", "checklist.md"), "complete checklist\n"),
      writeFile(join(skillRoot, "scripts", "check.sh"), "#!/bin/sh\nexit 0\n"),
      writeFile(join(skillRoot, "node_modules", "ignored", "secret"), "do not copy\n"),
    ]);
    await chmod(join(skillRoot, "scripts", "check.sh"), 0o755);
    const sessionDir = join(root, "session");
    const systemPrompt = "SYSTEM LINE ONE\nSYSTEM LINE TWO\n";
    const managed = await prepareManagedAntigravityHome({
      agent: createExpert(root, skillRoot),
      sessionDir,
      systemPrompt,
      mcpServerUrl: "http://127.0.0.1:43127/sessions/token/mcp",
      hookRelay: {
        url: "http://127.0.0.1:43128/pre-tool-use",
        authorization: "Bearer secret",
        close: async () => undefined,
      },
      permissionMode: "request-approval",
      processEnvironment: {
        HOME: "/host/home",
        AGY_APP_DATA_DIR: "/host/agy",
        GEMINI_CONFIG_DIR: "/host/gemini",
        XDG_STATE_HOME: "/host/state",
        XDG_RUNTIME_DIR: "/host/run",
        ELECTRON_RUN_AS_NODE: "host-value",
        GOOGLE_APPLICATION_CREDENTIALS: "/auth/adc.json",
      },
      nodeExecutablePath: "/opt/node with spaces",
      platform: "linux",
    });

    expect(managed.homeDir).toBe(join(sessionDir, "home"));
    expect(managed.appDataDir).toBe(join(managed.homeDir, ".gemini", "antigravity-cli"));
    expect(managed.configDir).toBe(join(managed.homeDir, ".gemini", "config"));
    expect(managed.skills).toEqual([expect.stringMatching(/^pragma-[0-9a-f]{16}-review-skill$/)]);
    expect(managed.env).toMatchObject({
      HOME: managed.homeDir,
      USERPROFILE: managed.homeDir,
      TMPDIR: join(sessionDir, "tmp"),
      XDG_STATE_HOME: join(managed.homeDir, ".local", "state"),
      XDG_RUNTIME_DIR: join(sessionDir, "tmp"),
      GOOGLE_APPLICATION_CREDENTIALS: "/auth/adc.json",
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    });
    expect(managed.env["AGY_APP_DATA_DIR"]).toBeUndefined();
    expect(managed.env["GEMINI_CONFIG_DIR"]).toBeUndefined();
    expect(managed.env["PRAGMA_AGY_HOOK_URL"]).toBeUndefined();
    expect(managed.env["PRAGMA_AGY_HOOK_AUTHORIZATION"]).toBeUndefined();
    expect(managed.env["ELECTRON_RUN_AS_NODE"]).toBeUndefined();

    await expect(readJson(join(managed.configDir, "mcp_config.json"))).resolves.toEqual({
      mcpServers: {
        [managed.mcpServerName]: {
          serverUrl: "http://127.0.0.1:43127/sessions/token/mcp",
        },
      },
    });
    await expect(readJson(join(managed.appDataDir, "settings.json"))).resolves.toMatchObject({
      toolPermission: "request-review",
      artifactReviewPolicy: "always-proceed",
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: true,
      permissions: {
        allow: [`mcp(${managed.mcpServerName}/*)`],
        deny: [],
        ask: [],
      },
      enableTelemetry: false,
    });
    await expect(readJson(join(managed.configDir, "hooks.json"))).resolves.toEqual({
      [managed.hookName]: {
        enabled: true,
        PreToolUse: [
          {
            matcher: "*",
            hooks: [
              {
                type: "command",
                command: expect.stringMatching(/^ELECTRON_RUN_AS_NODE=1 '\/opt\/node with spaces'/),
                timeout: 86_400,
              },
            ],
          },
        ],
      },
    });

    const agentFile = await readFile(
      join(managed.configDir, "agents", managed.agentName, "agent.md"),
      "utf8",
    );
    expect(agentFile).toContain(`name: "${managed.agentName}"`);
    expect(agentFile).toContain(
      "mainAgent: true\nsubagent: false\nhidden: false\ninheritMcp: true\ncommandExecutionPolicy: off",
    );
    expect(agentFile).toContain(`skills:\n  - "skills/${managed.skills[0]}"`);
    expect(agentFile.slice(agentFile.indexOf("---\n", 4) + 4)).toBe(
      `# System Prompt\n\n${systemPrompt}\n`,
    );
    const hookScript = await readFile(join(sessionDir, "hooks", "pragma-pre-tool-use.mjs"), "utf8");
    expect(hookScript).toContain('const url = "http://127.0.0.1:43128/pre-tool-use";');
    expect(hookScript).toContain('const authorization = "Bearer secret";');

    const copiedSkill = join(managed.configDir, "skills", managed.skills[0]!);
    await expect(readFile(join(copiedSkill, "SKILL.md"), "utf8")).resolves.toBe(
      `---\nname: "${managed.skills[0]}"\ndescription: "Review the repository"\n---\n# Review\n\nUse the reference.\n`,
    );
    await expect(readFile(join(copiedSkill, "references", "checklist.md"), "utf8")).resolves.toBe(
      "complete checklist\n",
    );
    await expect(stat(join(copiedSkill, "node_modules"))).rejects.toMatchObject({ code: "ENOENT" });
    expect((await lstat(copiedSkill)).isSymbolicLink()).toBe(false);

    if (process.platform !== "win32") {
      expect((await stat(join(managed.configDir, "mcp_config.json"))).mode & 0o777).toBe(0o600);
      expect((await stat(join(sessionDir, "hooks", "pragma-pre-tool-use.mjs"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(join(copiedSkill, "references", "checklist.md"))).mode & 0o777).toBe(
        0o600,
      );
      expect((await stat(join(copiedSkill, "scripts", "check.sh"))).mode & 0o777).toBe(0o700);
      expect((await stat(managed.homeDir)).mode & 0o777).toBe(0o700);
    }
  });

  it.each([
    ["request-approval", "request-review", true, false],
    ["auto-approve", "proceed-in-sandbox", true, false],
    ["full-access", "always-proceed", false, true],
  ] as const)(
    "maps %s to the documented Antigravity permission settings",
    async (permissionMode, toolPermission, enableTerminalSandbox, allowNonWorkspaceAccess) => {
      const root = await temporaryRoot();
      const managed = await prepareManagedAntigravityHome({
        agent: createExpert(root),
        sessionDir: join(root, "session"),
        systemPrompt: "system",
        mcpServerUrl: "http://127.0.0.1/mcp",
        hookRelay: {
          url: "http://127.0.0.1/hook",
          authorization: "Bearer token",
          close: async () => undefined,
        },
        permissionMode,
        processEnvironment: {},
      });

      await expect(readJson(join(managed.appDataDir, "settings.json"))).resolves.toMatchObject({
        toolPermission,
        enableTerminalSandbox,
        allowNonWorkspaceAccess,
      });
      const agentFile = await readFile(
        join(managed.configDir, "agents", managed.agentName, "agent.md"),
        "utf8",
      );
      expect(agentFile).toContain(
        `commandExecutionPolicy: ${
          permissionMode === "full-access"
            ? "eager"
            : permissionMode === "auto-approve"
              ? "sandbox"
              : "off"
        }`,
      );
    },
  );

  it("replaces stale managed skills while preserving complete source support files", async () => {
    const root = await temporaryRoot();
    const sessionDir = join(root, "session");
    const firstSkill = join(root, "first-skill");
    await mkdir(firstSkill, { recursive: true });
    await writeFile(
      join(firstSkill, "SKILL.md"),
      "---\nname: retained\ndescription: Existing description\n---\nFirst\n",
    );
    const first = await prepareManagedAntigravityHome({
      agent: createExpert(root, firstSkill),
      sessionDir,
      systemPrompt: "first system",
      mcpServerUrl: "http://127.0.0.1/first",
      hookRelay: relay(),
      permissionMode: "request-approval",
      processEnvironment: {},
    });
    await expect(
      readFile(join(first.configDir, "skills", first.skills[0]!, "SKILL.md"), "utf8"),
    ).resolves.toContain(`name: "${first.skills[0]}"\ndescription: Existing description`);
    await writeFile(join(first.configDir, "skills", "stale.txt"), "stale");
    const nativeAgent = join(first.configDir, "agents", "native-created-subagent", "agent.md");
    await mkdir(join(first.configDir, "agents", "native-created-subagent"), { recursive: true });
    await writeFile(nativeAgent, "native conversation state\n");

    const second = await prepareManagedAntigravityHome({
      agent: createExpert(root),
      sessionDir,
      systemPrompt: "second system",
      mcpServerUrl: "http://127.0.0.1/second",
      hookRelay: relay(),
      permissionMode: "request-approval",
      processEnvironment: {},
    });

    expect(second.skills).toEqual([]);
    expect(second.agentName).toBe(first.agentName);
    expect(second.mcpServerName).toBe(first.mcpServerName);
    await expect(readFile(nativeAgent, "utf8")).resolves.toBe("native conversation state\n");
    await expect(stat(join(second.configDir, "skills", "stale.txt"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(second.configDir, "mcp_config.json"), "utf8")).resolves.toContain(
      "http://127.0.0.1/second",
    );
  });

  it("creates Windows HOME variables and strips case-insensitive host overrides", () => {
    const env = createManagedAntigravityEnvironment({
      base: {
        Home: "C:\\Host",
        agy_app_data_dir: "C:\\Host\\agy",
        Antigravity_Conversation_Id: "host-conversation",
        ANTIGRAVITY_EXECUTABLE_DATA_DIR: "C:\\Host\\sidecar-data",
        GOOGLE_LOG_DIR: "C:\\Host\\logs",
        GEMINI_CONFIG_DIR: "C:\\Host\\gemini",
        API_KEY: "preserved",
      },
      homeDir: "C:\\Pragma\\Session\\home",
      tmpDir: "C:\\Pragma\\Session\\tmp",
      platform: "win32",
    });

    expect(env).toMatchObject({
      HOME: "C:\\Pragma\\Session\\home",
      USERPROFILE: "C:\\Pragma\\Session\\home",
      HOMEDRIVE: "C:",
      HOMEPATH: "\\Pragma\\Session\\home",
      API_KEY: "preserved",
    });
    expect(Object.keys(env).some((key) => key.toLowerCase() === "agy_app_data_dir")).toBe(false);
    expect(
      Object.keys(env).some((key) => key.toLowerCase() === "antigravity_conversation_id"),
    ).toBe(false);
    expect(
      Object.keys(env).some((key) => key.toLowerCase() === "antigravity_executable_data_dir"),
    ).toBe(false);
    expect(Object.keys(env).some((key) => key.toLowerCase() === "google_log_dir")).toBe(false);
    expect(Object.keys(env).some((key) => key.toLowerCase() === "gemini_config_dir")).toBe(false);
  });

  it("produces stable and filesystem-safe custom-agent names", () => {
    expect(managedAgentName(" Expert / 中文 / 123 ", "0123456789abcdef")).toBe(
      "pragma-expert-123-0123456789abcdef",
    );
    expect(managedAgentName("---", "0123456789abcdef")).toBe("pragma-expert-0123456789abcdef");
    expect(createManagedAntigravityIdentity("expert", "/session/one")).toEqual(
      createManagedAntigravityIdentity("expert", "/session/one"),
    );
    expect(createManagedAntigravityIdentity("expert", "/session/one")).not.toEqual(
      createManagedAntigravityIdentity("expert", "/session/two"),
    );
  });

  it("keeps normalized and deduplicated Skill identifiers within the 64-character limit", async () => {
    const root = await temporaryRoot();
    const firstSkill = join(root, "first-skill");
    const secondSkill = join(root, "second-skill");
    await Promise.all([mkdir(firstSkill), mkdir(secondSkill)]);
    await Promise.all([
      writeFile(join(firstSkill, "SKILL.md"), "First\n"),
      writeFile(join(secondSkill, "SKILL.md"), "Second\n"),
    ]);
    const longName = ` ${"A".repeat(80)} `;
    const agent = {
      ...createExpert(root),
      skills: {
        skills: [
          {
            type: "local",
            name: longName,
            description: "First skill",
            path: join(firstSkill, "SKILL.md"),
          },
          {
            type: "local",
            name: longName,
            description: "Second skill",
            path: join(secondSkill, "SKILL.md"),
          },
        ],
      },
    } as unknown as Expert;

    const managed = await prepareManagedAntigravityHome({
      agent,
      sessionDir: join(root, "session"),
      systemPrompt: "system",
      mcpServerUrl: "http://127.0.0.1/mcp",
      hookRelay: relay(),
      permissionMode: "request-approval",
      processEnvironment: {},
    });

    const prefix = `pragma-${createManagedAntigravityIdentity(agent.id, join(root, "session")).namespace}-`;
    const available = 64 - prefix.length;
    expect(managed.skills).toEqual([
      `${prefix}${"a".repeat(available)}`,
      `${prefix}${"a".repeat(available - 2)}-2`,
    ]);
    expect(managed.skills.every((name) => name.length <= 64)).toBe(true);
    await expect(
      readFile(join(managed.configDir, "skills", managed.skills[1]!, "SKILL.md"), "utf8"),
    ).resolves.toContain(`name: "${prefix}${"a".repeat(available - 2)}-2"`);
  });
});

function createExpert(workspace: string, skillRoot?: string): Expert {
  return {
    id: "01h8z8e7m6p5t4r3",
    name: "Review Expert",
    description: "Review the repository",
    workspace,
    ...(skillRoot === undefined
      ? {}
      : {
          skills: {
            skills: [
              {
                type: "local",
                name: "Review Skill",
                description: "Review the repository",
                path: join(skillRoot, "SKILL.md"),
              },
            ],
          },
        }),
  } as unknown as Expert;
}

function relay() {
  return {
    url: "http://127.0.0.1/hook",
    authorization: "Bearer token",
    close: async () => undefined,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pragma-agy-home-test-"));
  temporaryDirectories.push(root);
  return root;
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}
