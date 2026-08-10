export function deleteEnvironmentValue(
  env: NodeJS.ProcessEnv,
  key: string,
  platform: NodeJS.Platform,
): void {
  if (platform !== "win32") {
    delete env[key];
    return;
  }
  const normalized = key.toLowerCase();
  for (const candidate of Object.keys(env)) {
    if (candidate.toLowerCase() === normalized) delete env[candidate];
  }
}

export function applyCommonAntigravityEnvironment(options: {
  readonly env: NodeJS.ProcessEnv;
  readonly tmpDir: string;
  readonly platform: NodeJS.Platform;
}): void {
  for (const key of [
    "XDG_RUNTIME_DIR",
    "TMPDIR",
    "TMP",
    "TEMP",
    "AGY_CLI_DISABLE_AUTO_UPDATE",
    "NO_COLOR",
  ]) {
    deleteEnvironmentValue(options.env, key, options.platform);
  }
  options.env["XDG_RUNTIME_DIR"] = options.tmpDir;
  options.env["TMPDIR"] = options.tmpDir;
  options.env["TMP"] = options.tmpDir;
  options.env["TEMP"] = options.tmpDir;
  options.env["AGY_CLI_DISABLE_AUTO_UPDATE"] = "true";
  options.env["NO_COLOR"] = "1";
}
