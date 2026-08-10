import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import {
  access,
  chmod,
  cp,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, isAbsolute, join, posix, resolve, win32 } from "node:path";

import type { Expert } from "@pragma/core";

import {
  applyCommonAntigravityEnvironment,
  deleteEnvironmentValue,
} from "./environment-variables.ts";
import type { AntigravityHookRelay } from "./permission-hooks.ts";
import type { AntigravityRuntimePermissionMode } from "./types.ts";

const FRONTMATTER_DELIMITER = "---";
const NON_ALPHANUMERIC = /[^a-z0-9]+/g;
const MAX_SKILL_NAME_CHARACTERS = 64;
const MANAGED_NAMESPACE_CHARACTERS = 16;
const MAX_AGENT_ID_CHARACTERS = 32;

export interface ManagedAntigravityIdentity {
  readonly namespace: string;
  readonly agentName: string;
  readonly mcpServerName: string;
  readonly hookName: string;
}

export interface ManagedAntigravityHome {
  readonly homeDir: string;
  readonly appDataDir: string;
  readonly configDir: string;
  readonly agentName: string;
  readonly mcpServerName: string;
  readonly hookName: string;
  readonly logDir: string;
  readonly env: NodeJS.ProcessEnv;
  readonly skills: readonly string[];
}

export async function prepareManagedAntigravityHome(options: {
  readonly agent: Expert;
  readonly sessionDir: string;
  readonly systemPrompt: string;
  readonly mcpServerUrl: string;
  readonly hookRelay: AntigravityHookRelay;
  readonly permissionMode: AntigravityRuntimePermissionMode;
  readonly processEnvironment: Readonly<NodeJS.ProcessEnv>;
  readonly nodeExecutablePath?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
}): Promise<ManagedAntigravityHome> {
  const platform = options.platform ?? process.platform;
  const homeDir = join(options.sessionDir, "home");
  const geminiDir = join(homeDir, ".gemini");
  const appDataDir = join(geminiDir, "antigravity-cli");
  const configDir = join(geminiDir, "config");
  const logDir = join(options.sessionDir, "logs");
  const tmpDir = join(options.sessionDir, "tmp");
  const hookDir = join(options.sessionDir, "hooks");
  const skillsDir = join(configDir, "skills");
  const agentsDir = join(configDir, "agents");
  const identity = createManagedAntigravityIdentity(options.agent.id, options.sessionDir);
  const managedAgentDir = join(agentsDir, identity.agentName);

  for (const directory of [homeDir, appDataDir, configDir, logDir, tmpDir, hookDir]) {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700).catch(() => undefined);
  }
  // Replace only Pragma's own entry. Antigravity can persist dynamically
  // defined subagents beside it as part of the native conversation state.
  await rm(managedAgentDir, { recursive: true, force: true });
  await mkdir(managedAgentDir, { recursive: true, mode: 0o700 });

  const hookScriptPath = join(hookDir, "pragma-pre-tool-use.mjs");
  await writePrivateFile(hookScriptPath, createHookRunnerSource(options.hookRelay));

  const skills = await materializeAntigravitySkills(options.agent, skillsDir, identity.namespace);
  await Promise.all([
    writePrivateJson(
      join(appDataDir, "settings.json"),
      managedSettings(options.permissionMode, identity.mcpServerName),
    ),
    writePrivateJson(join(configDir, "mcp_config.json"), {
      mcpServers: {
        [identity.mcpServerName]: {
          serverUrl: options.mcpServerUrl,
        },
      },
    }),
    writePrivateJson(
      join(configDir, "hooks.json"),
      managedHooksConfig(
        options.nodeExecutablePath ?? process.execPath,
        hookScriptPath,
        platform,
        identity.hookName,
      ),
    ),
    writePrivateFile(
      join(managedAgentDir, "agent.md"),
      managedAgentMarkdown(
        options.agent,
        identity.agentName,
        options.systemPrompt,
        options.permissionMode,
        skills,
      ),
    ),
  ]);
  const env = createManagedAntigravityEnvironment({
    base: options.processEnvironment,
    homeDir,
    tmpDir,
    platform,
  });

  return {
    homeDir,
    appDataDir,
    configDir,
    agentName: identity.agentName,
    mcpServerName: identity.mcpServerName,
    hookName: identity.hookName,
    logDir,
    env,
    skills,
  };
}

export function createManagedAntigravityEnvironment(options: {
  readonly base: Readonly<NodeJS.ProcessEnv>;
  readonly homeDir: string;
  readonly tmpDir: string;
  readonly platform?: NodeJS.Platform | undefined;
}): NodeJS.ProcessEnv {
  const platform = options.platform ?? process.platform;
  const environmentPath = platform === "win32" ? win32 : posix;
  const env: NodeJS.ProcessEnv = { ...options.base };
  for (const key of [
    "AGY_APP_DATA_DIR",
    "ANTIGRAVITY_HOME",
    "ANTIGRAVITY_AGENTAPI_EXE",
    "ANTIGRAVITY_CONVERSATION_ID",
    "ANTIGRAVITY_CSRF_TOKEN",
    "ANTIGRAVITY_EXECUTABLE_DATA_DIR",
    "ANTIGRAVITY_LS_ADDRESS",
    "ANTIGRAVITY_PROJECT_ID",
    "ANTIGRAVITY_SIDECAR_UI_TOKEN",
    "ANTIGRAVITY_SIDECAR_WEB_PORT",
    "GEMINI_CLI_HOME",
    "GEMINI_CONFIG_DIR",
    "GOOGLE_LOG_DIR",
    "GOOGLE_STATUS_DIR",
    "HOME",
    "USERPROFILE",
    "XDG_CONFIG_HOME",
    "XDG_CACHE_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "PRAGMA_AGY_HOOK_URL",
    "PRAGMA_AGY_HOOK_AUTHORIZATION",
    "ELECTRON_RUN_AS_NODE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
  ]) {
    deleteEnvironmentValue(env, key, platform);
  }

  env["HOME"] = options.homeDir;
  env["USERPROFILE"] = options.homeDir;
  env["XDG_CONFIG_HOME"] = environmentPath.join(options.homeDir, ".config");
  env["XDG_CACHE_HOME"] = environmentPath.join(options.homeDir, ".cache");
  env["XDG_DATA_HOME"] = environmentPath.join(options.homeDir, ".local", "share");
  env["XDG_STATE_HOME"] = environmentPath.join(options.homeDir, ".local", "state");
  applyCommonAntigravityEnvironment({ env, tmpDir: options.tmpDir, platform });
  if (platform === "win32") {
    const root = environmentPath.parse(options.homeDir).root;
    env["HOMEDRIVE"] = root.replace(/[\\/]$/, "");
    env["HOMEPATH"] = options.homeDir.slice(root.length - 1);
    env["APPDATA"] = environmentPath.join(options.homeDir, "AppData", "Roaming");
    env["LOCALAPPDATA"] = environmentPath.join(options.homeDir, "AppData", "Local");
  }
  return env;
}

export function createManagedAntigravityIdentity(
  agentId: string,
  sessionDir: string,
): ManagedAntigravityIdentity {
  const namespace = createHash("sha256")
    .update("pragma.antigravity-managed-identity/v1\0")
    .update(resolve(sessionDir))
    .digest("hex")
    .slice(0, MANAGED_NAMESPACE_CHARACTERS);
  return {
    namespace,
    agentName: managedAgentName(agentId, namespace),
    // Keep the MCP name punctuation-free because some agy stream shapes embed
    // it in a generated native tool identifier.
    mcpServerName: `pragma${namespace}`,
    hookName: `pragma-permission-gate-${namespace}`,
  };
}

export function managedAgentName(agentId: string, namespace: string): string {
  const normalized = agentId
    .trim()
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_AGENT_ID_CHARACTERS);
  return `pragma-${normalized === "" ? "expert" : normalized}-${namespace}`;
}

function managedSettings(
  mode: AntigravityRuntimePermissionMode,
  mcpServerName: string,
): Record<string, unknown> {
  const common = {
    notifications: false,
    showTips: false,
    showFeedbackSurvey: false,
    enableTelemetry: false,
    verbosity: "high",
    artifactReviewPolicy: "always-proceed",
    permissions: {
      allow: [`mcp(${mcpServerName}/*)`],
      deny: [],
      ask: [],
    },
  };
  if (mode === "full-access") {
    return {
      ...common,
      toolPermission: "always-proceed",
      allowNonWorkspaceAccess: true,
      enableTerminalSandbox: false,
    };
  }
  if (mode === "auto-approve") {
    return {
      ...common,
      toolPermission: "proceed-in-sandbox",
      allowNonWorkspaceAccess: false,
      enableTerminalSandbox: true,
    };
  }
  return {
    ...common,
    toolPermission: "request-review",
    allowNonWorkspaceAccess: false,
    enableTerminalSandbox: true,
  };
}

function managedHooksConfig(
  nodeExecutablePath: string,
  hookScriptPath: string,
  platform: NodeJS.Platform,
  hookName: string,
): Record<string, unknown> {
  const runner = `${quoteCommandArgument(nodeExecutablePath, platform)} ${quoteCommandArgument(
    hookScriptPath,
    platform,
  )}`;
  return {
    [hookName]: {
      enabled: true,
      PreToolUse: [
        {
          matcher: "*",
          hooks: [
            {
              type: "command",
              command:
                platform === "win32"
                  ? `set "ELECTRON_RUN_AS_NODE=1" && ${runner}`
                  : `ELECTRON_RUN_AS_NODE=1 ${runner}`,
              timeout: 86_400,
            },
          ],
        },
      ],
    },
  };
}

function managedAgentMarkdown(
  agent: Expert,
  agentName: string,
  systemPrompt: string,
  permissionMode: AntigravityRuntimePermissionMode,
  skills: readonly string[],
): string {
  const frontmatter = [
    FRONTMATTER_DELIMITER,
    `name: ${quoteYamlString(agentName)}`,
    `description: ${quoteYamlString(agent.description || `Pragma Expert ${agent.name}`)}`,
    "mainAgent: true",
    "subagent: false",
    "hidden: false",
    "inheritMcp: true",
    `commandExecutionPolicy: ${commandExecutionPolicy(permissionMode)}`,
    ...(skills.length === 0
      ? []
      : ["skills:", ...skills.map((skill) => `  - ${quoteYamlString(`skills/${skill}`)}`)]),
    FRONTMATTER_DELIMITER,
  ];
  return [...frontmatter, "# System Prompt", "", systemPrompt, ""].join("\n");
}

function commandExecutionPolicy(
  mode: AntigravityRuntimePermissionMode,
): "off" | "sandbox" | "eager" {
  if (mode === "full-access") return "eager";
  if (mode === "auto-approve") return "sandbox";
  return "off";
}

async function materializeAntigravitySkills(
  agent: Expert,
  skillsDir: string,
  namespace: string,
): Promise<readonly string[]> {
  await rm(skillsDir, { recursive: true, force: true });
  await mkdir(skillsDir, { recursive: true, mode: 0o700 });
  const names: string[] = [];
  const usedSlugs = new Set<string>();

  for (const skill of agent.skills?.skills ?? []) {
    if (skill.path === undefined) continue;
    const source = await resolveSkillSource({
      path: skill.path,
      baseDir: skill.baseDir,
      workspace: agent.workspace,
    });
    const slug = allocateSkillSlug(usedSlugs, namespacedSkillName(skill.name, namespace));
    const targetDir = join(skillsDir, slug);
    await cp(source.dir, targetDir, {
      recursive: true,
      dereference: true,
      filter: (sourcePath) => basename(sourcePath) !== "node_modules",
    });
    await makeCopiedTreePrivate(targetDir);
    await writePrivateFile(
      join(targetDir, "SKILL.md"),
      ensureSkillFrontmatter(await readFile(source.skillFile, "utf8"), {
        name: slug,
        description: skill.description,
      }),
    );
    names.push(slug);
  }
  return names;
}

async function resolveSkillSource(options: {
  readonly path: string;
  readonly baseDir?: string | undefined;
  readonly workspace: string;
}): Promise<{ readonly dir: string; readonly skillFile: string }> {
  const resolvedPath = isAbsolute(options.path)
    ? options.path
    : resolve(options.baseDir ?? options.workspace, options.path);
  const info = await stat(resolvedPath);
  const dir = info.isDirectory() ? resolvedPath : dirname(resolvedPath);
  const skillFile = info.isDirectory() ? join(resolvedPath, "SKILL.md") : resolvedPath;
  await access(skillFile, constants.R_OK);
  return { dir, skillFile };
}

function namespacedSkillName(name: string, namespace: string): string {
  const prefix = `pragma-${namespace}-`;
  return `${prefix}${sanitizeSkillName(name, MAX_SKILL_NAME_CHARACTERS - prefix.length)}`;
}

function sanitizeSkillName(name: string, maximumCharacters: number): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(NON_ALPHANUMERIC, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maximumCharacters)
    .replace(/-+$/g, "");
  return slug === "" ? "skill" : slug;
}

async function makeCopiedTreePrivate(root: string): Promise<void> {
  await chmod(root, 0o700).catch(() => undefined);
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(
    entries.map(async (entry) => {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        await makeCopiedTreePrivate(path);
        return;
      }
      const sourceMode = (await stat(path)).mode;
      await chmod(path, (sourceMode & 0o111) === 0 ? 0o600 : 0o700).catch(() => undefined);
    }),
  );
}

function allocateSkillSlug(used: Set<string>, base: string): string {
  let slug = base;
  let index = 2;
  while (used.has(slug)) {
    const suffix = `-${index++}`;
    const prefix = base.slice(0, MAX_SKILL_NAME_CHARACTERS - suffix.length).replace(/-+$/g, "");
    slug = `${prefix === "" ? "skill" : prefix}${suffix}`;
  }
  used.add(slug);
  return slug;
}

function ensureSkillFrontmatter(
  content: string,
  fallback: { readonly name: string; readonly description: string },
): string {
  const parsed = parseFrontmatter(content);
  if (parsed === undefined) {
    return prependFrontmatter(content, fallback.name, fallback.description);
  }
  const lines = [...parsed.lines];
  const nameIndex = findFrontmatterKeyIndex(lines, "name");
  if (nameIndex < 0) {
    lines.unshift(`name: ${quoteYamlString(fallback.name)}`);
  } else {
    // Antigravity requires a lowercase, hyphenated skill identifier. Pragma's
    // declared name is authoritative, while the rest of the source frontmatter
    // and every support file remain intact.
    lines[nameIndex] = `name: ${quoteYamlString(fallback.name)}`;
  }
  if (!frontmatterHasKey(lines, "description")) {
    const normalizedNameIndex = findFrontmatterKeyIndex(lines, "name");
    lines.splice(
      normalizedNameIndex < 0 ? 0 : normalizedNameIndex + 1,
      0,
      `description: ${quoteYamlString(fallback.description)}`,
    );
  }
  return [
    FRONTMATTER_DELIMITER,
    ...lines,
    FRONTMATTER_DELIMITER,
    trimLeadingNewline(parsed.body),
  ].join("\n");
}

function prependFrontmatter(content: string, name: string, description: string): string {
  return [
    FRONTMATTER_DELIMITER,
    `name: ${quoteYamlString(name)}`,
    `description: ${quoteYamlString(description)}`,
    FRONTMATTER_DELIMITER,
    trimLeadingNewline(content),
  ].join("\n");
}

function parseFrontmatter(
  content: string,
): { readonly lines: readonly string[]; readonly body: string } | undefined {
  const normalized = content.replace(/\r\n/g, "\n");
  if (!normalized.startsWith(`${FRONTMATTER_DELIMITER}\n`)) return undefined;
  const endIndex = normalized.indexOf(`\n${FRONTMATTER_DELIMITER}\n`, 4);
  if (endIndex < 0) return undefined;
  return {
    lines: normalized.slice(4, endIndex).split("\n"),
    body: normalized.slice(endIndex + 5),
  };
}

function frontmatterHasKey(lines: readonly string[], key: string): boolean {
  return findFrontmatterKeyIndex(lines, key) >= 0;
}

function findFrontmatterKeyIndex(lines: readonly string[], key: string): number {
  return lines.findIndex((line) => {
    if (/^\s/.test(line)) return false;
    const colon = line.indexOf(":");
    return colon >= 0 && line.slice(0, colon).trim() === key;
  });
}

function quoteYamlString(value: string): string {
  return JSON.stringify(value);
}

function trimLeadingNewline(value: string): string {
  return value.startsWith("\n") ? value.slice(1) : value;
}

function quoteCommandArgument(value: string, platform: NodeJS.Platform): string {
  if (platform === "win32") {
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function createHookRunnerSource(
  hookRelay: Pick<AntigravityHookRelay, "url" | "authorization">,
): string {
  return [
    'import process from "node:process";',
    `const url = ${JSON.stringify(hookRelay.url)};`,
    `const authorization = ${JSON.stringify(hookRelay.authorization)};`,
    "const chunks = [];",
    "for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));",
    "try {",
    "  const response = await fetch(url, {",
    '    method: "POST",',
    '    headers: { "content-type": "application/json", authorization },',
    "    body: Buffer.concat(chunks),",
    "  });",
    "  if (!response.ok) throw new Error(`Pragma hook relay failed: ${response.status}.`);",
    "  process.stdout.write(await response.text());",
    "} catch {",
    '  process.stdout.write(JSON.stringify({ decision: "deny", reason: "Pragma approval bridge failed closed." }));',
    "}",
    "",
  ].join("\n");
}

async function writePrivateJson(path: string, value: unknown): Promise<void> {
  await writePrivateFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePrivateFile(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${randomUUID()}`;
  await writeFile(temporary, content, { mode: 0o600 });
  try {
    await rename(temporary, path);
  } catch (error) {
    if (!isReplaceError(error)) throw error;
    await rm(path, { force: true });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
  await chmod(path, 0o600).catch(() => undefined);
}

function isReplaceError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EEXIST" || error.code === "EPERM")
  );
}
