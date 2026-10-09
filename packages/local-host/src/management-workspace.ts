import { constants as fsConstants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function validateHostWorkspace(path: string): Promise<{
  readonly ok: boolean;
  readonly reason?:
    "not_absolute" | "not_directory" | "not_found" | "not_readable" | "not_writable" | "error";
  readonly error?: string;
}> {
  if (!path || !isAbsolute(path)) {
    return { ok: false, reason: "not_absolute" };
  }

  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) {
      return { ok: false, reason: "not_directory" };
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      return { ok: false, reason: "not_found" };
    }
    return { ok: false, reason: "error", error: errorMessage(error) };
  }

  try {
    await access(path, fsConstants.R_OK);
  } catch {
    return { ok: false, reason: "not_readable" };
  }

  try {
    await access(path, fsConstants.W_OK);
  } catch {
    return { ok: false, reason: "not_writable" };
  }

  return { ok: true };
}
