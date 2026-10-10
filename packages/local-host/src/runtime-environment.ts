import {
  DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
  RuntimeProcessEnvironmentPolicySchema,
  type RuntimeProcessEnvironmentPolicy,
} from "@pragma/shared";

/**
 * Keeps common toolchain paths available by default. Additional variables are
 * passed only when a Runtime policy explicitly allows them.
 */
export function filterLocalHostRuntimeProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  return resolveLocalHostRuntimeProcessEnvironment(
    environment,
    "",
    DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
    platform,
  );
}

export function resolveLocalHostRuntimeProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  runtimeAdapterId: string,
  policyInput: RuntimeProcessEnvironmentPolicy = DEFAULT_RUNTIME_PROCESS_ENVIRONMENT_POLICY,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const policy = RuntimeProcessEnvironmentPolicySchema.parse(policyInput);
  const allowed = platform === "win32" ? WINDOWS_VARIABLES : UNIX_VARIABLES;
  const allowlist = new Set(policy.allowlist.map((name) => normalizeVariableName(name, platform)));
  const blocklist = new Set(policy.blocklist.map((name) => normalizeVariableName(name, platform)));
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value === undefined) continue;
    const normalized = normalizeVariableName(key, platform);
    if (blocklist.has(normalized)) continue;
    const isOpenCodeConfiguration =
      runtimeAdapterId === "pragma.runtime.opencode" &&
      normalized === normalizeVariableName("OPENCODE_CONFIG_CONTENT", platform);
    const isAllowed =
      policy.mode === "inherit-all" ||
      allowed.has(normalized) ||
      (platform !== "win32" && normalized.startsWith("LC_")) ||
      allowlist.has(normalized) ||
      isOpenCodeConfiguration;
    if (isAllowed) filtered[key] = value;
  }
  return filtered;
}

function normalizeVariableName(name: string, platform: NodeJS.Platform): string {
  return platform === "win32" ? name.toUpperCase() : name;
}

const UNIX_VARIABLES = new Set([
  "HOME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LOGNAME",
  "PATH",
  "SHELL",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USER",
  "ASDF_DATA_DIR",
  "BUN_INSTALL",
  "CARGO_HOME",
  "DENO_INSTALL",
  "FNM_DIR",
  "GOPATH",
  "GOROOT",
  "JAVA_HOME",
  "MISE_DATA_DIR",
  "NVM_DIR",
  "NVM_BIN",
  "PNPM_HOME",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "RUSTUP_HOME",
  "VOLTA_HOME",
  "ANDROID_HOME",
  "ANDROID_NDK_HOME",
  "ANDROID_SDK_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_USER_HOME",
  "ANDROID_EMULATOR_HOME",
  "ANDROID_AVD_HOME",
  "GRADLE_USER_HOME",
  "MAVEN_HOME",
  "M2_HOME",
  "KOTLIN_HOME",
  "FLUTTER_HOME",
  "FLUTTER_ROOT",
  "PUB_CACHE",
  "DEVELOPER_DIR",
  "CODEX_HOME",
  "QODERCLI_PATH",
  "AGY_PATH",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
]);

const WINDOWS_VARIABLES = new Set([
  "APPDATA",
  "COMSPEC",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "PROGRAMW6432",
  "SHELL",
  "SYSTEMDRIVE",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERDOMAIN",
  "USERNAME",
  "USERPROFILE",
  "ANDROID_HOME",
  "ANDROID_NDK_HOME",
  "ANDROID_SDK_HOME",
  "ANDROID_SDK_ROOT",
  "ANDROID_USER_HOME",
  "ANDROID_EMULATOR_HOME",
  "ANDROID_AVD_HOME",
  "GRADLE_USER_HOME",
  "MAVEN_HOME",
  "M2_HOME",
  "KOTLIN_HOME",
  "FLUTTER_HOME",
  "FLUTTER_ROOT",
  "PUB_CACHE",
  "CODEX_HOME",
  "QODERCLI_PATH",
  "AGY_PATH",
  "OPENCODE_CONFIG",
  "OPENCODE_CONFIG_DIR",
]);
