import { chmod, copyFile, mkdir, rm, stat, symlink } from "node:fs/promises";
import { join } from "node:path";

/** Keep native conversations owned by the Pragma Runtime Session while reusing CLI login. */
export async function prepareOpenCodeDataHome(
  environment: Readonly<NodeJS.ProcessEnv>,
  sessionDir: string,
): Promise<NodeJS.ProcessEnv> {
  const home = environment["HOME"] ?? environment["USERPROFILE"];
  if (home === undefined && environment["XDG_DATA_HOME"] === undefined) {
    throw new Error(
      "OpenCode authentication root is unavailable: HOME or XDG_DATA_HOME is required.",
    );
  }
  const sourceDataHome = environment["XDG_DATA_HOME"] ?? join(home!, ".local", "share");
  const dataHome = join(sessionDir, "data");
  if (sourceDataHome === dataHome) return { ...environment, XDG_DATA_HOME: dataHome };
  const nativeHome = join(dataHome, "opencode");
  await mkdir(nativeHome, { recursive: true, mode: 0o700 });
  await chmod(dataHome, 0o700);
  await chmod(nativeHome, 0o700);

  const sourceAuth = join(sourceDataHome, "opencode", "auth.json");
  const targetAuth = join(nativeHome, "auth.json");
  await rm(targetAuth, { force: true });
  try {
    const source = await stat(sourceAuth);
    if (!source.isFile()) throw new Error("OpenCode auth.json is not a regular file.");
  } catch (error) {
    if (isMissing(error)) return { ...environment, XDG_DATA_HOME: dataHome };
    throw error;
  }
  try {
    await symlink(sourceAuth, targetAuth, "file");
  } catch (error) {
    if (!isSymlinkUnavailable(error)) throw error;
    await copyFile(sourceAuth, targetAuth);
    await chmod(targetAuth, 0o600);
  }
  return { ...environment, XDG_DATA_HOME: dataHome };
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

function isSymlinkUnavailable(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "EPERM" || error.code === "EACCES" || error.code === "ENOTSUP")
  );
}
