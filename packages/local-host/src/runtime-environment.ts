/**
 * Keep the process environment used to discover/launch local runtimes small.
 * Credentials and unrelated shell state are intentionally not a runtime input.
 */
export function filterLocalHostRuntimeProcessEnvironment(
  environment: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const allowed = platform === "win32" ? WINDOWS_VARIABLES : UNIX_VARIABLES;
  const filtered: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    const normalized = key.toUpperCase();
    if (
      value !== undefined &&
      (allowed.has(normalized) || (platform !== "win32" && normalized.startsWith("LC_")))
    ) {
      filtered[key] = value;
    }
  }
  return filtered;
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
  "PNPM_HOME",
  "PYENV_ROOT",
  "RBENV_ROOT",
  "RUSTUP_HOME",
  "VOLTA_HOME",
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
]);
