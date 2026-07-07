import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";

const USER_MEMORY_HOME = resolve(homedir(), ".pragma", "memories");

export function sanitizeMemoryPathSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

export function expandHomePath(path: string): string {
  if (path === "~") {
    return homedir();
  }

  if (path.startsWith("~/")) {
    return resolve(homedir(), path.slice(2));
  }

  return path;
}

export function resolveUserMemoryHome(): string {
  return USER_MEMORY_HOME;
}

export function resolveMemoryDirectory(options: {
  readonly category: string;
  readonly agentId: string;
  readonly rootDir?: string | undefined;
}): string {
  const configuredRoot = options.rootDir;
  const baseDir =
    configuredRoot === undefined ? resolveUserMemoryHome() : resolveConfiguredPath(configuredRoot);

  return resolve(baseDir, sanitizeMemoryPathSegment(options.agentId), options.category);
}

export function resolveMemoryFilePath(options: {
  readonly category: string;
  readonly agentId: string;
  readonly fileName: string;
  readonly filePath?: string | undefined;
}): string {
  if (options.filePath !== undefined) {
    return resolveConfiguredPath(options.filePath);
  }

  return resolve(
    resolveMemoryDirectory({
      category: options.category,
      agentId: options.agentId,
    }),
    options.fileName,
  );
}

export async function readJsonFile<TValue>(path: string, defaultValue: TValue): Promise<TValue> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as TValue;
  } catch (error) {
    if (isNotFoundError(error)) {
      return defaultValue;
    }

    throw error;
  }
}

export async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolveConfiguredPath(path: string): string {
  const expandedPath = expandHomePath(path);

  return isAbsolute(expandedPath)
    ? resolve(expandedPath)
    : resolve(resolveUserMemoryHome(), expandedPath);
}

function isNotFoundError(error: unknown): boolean {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
